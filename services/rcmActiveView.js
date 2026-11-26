'use strict';

/**
 * services/rcmActiveView.js
 *
 * Stores month-scoped active buyers (self_pv > 0) for sub-millisecond bucket & leg analytics,
 * AND maintains complete tree counters (Total Members, Terminated, Inactive, Active Buyers)
 * with zero RCM portal load and low DB overhead.
 */

const models = require('../models');
const { sequelize } = models;

const BATCH = 400;
const COUNT_CACHE_TTL_MS = 30 * 1000;
const countCache = new Map();

const DDL_VIEW = `
CREATE TABLE IF NOT EXISTS rcm_active_view (
  owner_id   BIGINT NOT NULL,
  month_key  CHAR(6) NOT NULL,
  buyer_id   BIGINT NOT NULL,
  parent_id  BIGINT NULL,
  leg        CHAR(1) NULL,
  depth      SMALLINT NOT NULL DEFAULT 0,
  name       VARCHAR(255) NULL,
  self_pv    DECIMAL(14,2) NOT NULL DEFAULT 0,
  amt        DECIMAL(14,2) NOT NULL DEFAULT 0,
  amt_known  TINYINT NOT NULL DEFAULT 0,
  run_seq    BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (owner_id, month_key, buyer_id),
  KEY idx_leg_pv (owner_id, month_key, leg, self_pv)
)`;

const DDL_STATE = `
CREATE TABLE IF NOT EXISTS rcm_sync_state (
  owner_id           BIGINT NOT NULL,
  month_key          CHAR(6) NOT NULL,
  state              VARCHAR(20) NOT NULL,
  macro_pv           DECIMAL(14,2) NOT NULL DEFAULT 0,
  processed_pv       DECIMAL(14,2) NOT NULL DEFAULT 0,
  residual_pv        DECIMAL(14,2) NOT NULL DEFAULT 0,
  verified_amt       DECIMAL(16,2) NOT NULL DEFAULT 0,
  est_low            DECIMAL(16,2) NULL,
  est_high           DECIMAL(16,2) NULL,
  total_members      INT NOT NULL DEFAULT 0,
  terminated_members INT NOT NULL DEFAULT 0,
  inactive_members   INT NOT NULL DEFAULT 0,
  buyers             INT NOT NULL DEFAULT 0,
  live_nodes         INT NOT NULL DEFAULT 0,
  coverage_pct       DECIMAL(5,1) NOT NULL DEFAULT 0,
  anomalies          INT NOT NULL DEFAULT 0,
  pv_mismatch        INT NOT NULL DEFAULT 0,
  verified_at        DATETIME(3) NULL,
  updated_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (owner_id, month_key)
)`;

let lastSeq = 0;
const nextSeq = () => {
  lastSeq = Math.max(Date.now(), lastSeq + 1);
  return lastSeq;
};

let ensurePromise = null;
function ensureTables() {
  if (!sequelize) return Promise.reject(new Error('sequelize instance not available from ../models'));
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await sequelize.query(DDL_VIEW);
      await sequelize.query(DDL_STATE);
      const tryAddCol = async (colDef) => {
        try {
          await sequelize.query(`ALTER TABLE rcm_sync_state ADD COLUMN ${colDef}`);
        } catch (e) {
          /* ignore existing column */
        }
      };
      await tryAddCol('total_members INT NOT NULL DEFAULT 0');
      await tryAddCol('terminated_members INT NOT NULL DEFAULT 0');
      await tryAddCol('inactive_members INT NOT NULL DEFAULT 0');
    })().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => Math.round(num(v) * 100) / 100;
const select = (sql, replacements = {}) =>
  sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

async function computeTreeCountsCached(owner) {
  const key = String(owner);
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_CACHE_TTL_MS) {
    return hit.value;
  }

  let result = null;

  // 1. Fast indexed lookup via root_buyer_id for top-level roots
  try {
    const rootCounts = await select(
      `SELECT
         COUNT(*) AS total_count,
         SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS term_count,
         SUM(CASE WHEN status = 1 AND COALESCE(self_pv, 0) = 0 AND COALESCE(repurchase_amt, 0) = 0 THEN 1 ELSE 0 END) AS inact_count
       FROM rcm_downline_nodes
       WHERE root_buyer_id = :owner OR buyer_id = :owner`,
      { owner }
    );
    const totalFromRoot = rootCounts && rootCounts[0] ? num(rootCounts[0].total_count) : 0;
    if (totalFromRoot > 1) {
      result = {
        totalCount: totalFromRoot,
        termCount: num(rootCounts[0].term_count),
        inactCount: num(rootCounts[0].inact_count)
      };
    }
  } catch {
    /* ignore if root_buyer_id is not present */
  }

  // 2. Recursive subtree fallback via parent_id for downline leaders
  if (!result) {
    try {
      const cteCounts = await select(
        `WITH RECURSIVE subtree AS (
           SELECT buyer_id, status, self_pv, repurchase_amt, 0 AS depth
           FROM rcm_downline_nodes
           WHERE buyer_id = :owner
           UNION ALL
           SELECT n.buyer_id, n.status, n.self_pv, n.repurchase_amt, s.depth + 1
           FROM rcm_downline_nodes n
           INNER JOIN subtree s ON n.parent_id = s.buyer_id
           WHERE s.depth < 150
         )
         SELECT
           COUNT(*) AS total_count,
           SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS term_count,
           SUM(CASE WHEN status = 1 AND COALESCE(self_pv, 0) = 0 AND COALESCE(repurchase_amt, 0) = 0 THEN 1 ELSE 0 END) AS inact_count
         FROM subtree`,
        { owner }
      );
      const totalFromCte = cteCounts && cteCounts[0] ? num(cteCounts[0].total_count) : 0;
      if (totalFromCte > 0) {
        result = {
          totalCount: totalFromCte,
          termCount: num(cteCounts[0].term_count),
          inactCount: num(cteCounts[0].inact_count)
        };
      }
    } catch {
      /* ignore if CTE is not supported */
    }
  }

  if (countCache.size > 100) {
    countCache.clear();
  }
  countCache.set(key, { at: Date.now(), value: result });
  return result;
}

async function replaceOwnerView({ ownerId, monthKey, rows, deleteStale }) {
  await ensureTables();
  const stamp = new Date();
  const seq = nextSeq();
  const owner = Number(ownerId);
  const safeRows = Array.isArray(rows) ? rows : [];

  for (let i = 0; i < safeRows.length; i += BATCH) {
    const part = safeRows.slice(i, i + BATCH).map((r) => [
      owner,
      monthKey,
      Number(r.buyer_id),
      r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
      r.leg || null,
      Number(r.depth) || 0,
      r.name ? String(r.name).slice(0, 255) : null,
      round2(r.self_pv),
      round2(r.amt),
      r.amt_known ? 1 : 0,
      seq,
      stamp
    ]);

    await sequelize.query(
      `INSERT INTO rcm_active_view
         (owner_id, month_key, buyer_id, parent_id, leg, depth, name, self_pv, amt, amt_known, run_seq, updated_at)
       VALUES :rows
       ON DUPLICATE KEY UPDATE
         parent_id = VALUES(parent_id), leg = VALUES(leg), depth = VALUES(depth),
         name = COALESCE(VALUES(name), name),
         self_pv = VALUES(self_pv),
         amt = IF(VALUES(amt_known) = 1, VALUES(amt), amt),
         amt_known = GREATEST(amt_known, VALUES(amt_known)),
         run_seq = VALUES(run_seq),
         updated_at = VALUES(updated_at)`,
      { replacements: { rows: part } }
    );
  }

  if (deleteStale) {
    await sequelize.query(
      'DELETE FROM rcm_active_view WHERE owner_id = :owner AND month_key = :monthKey AND run_seq < :seq',
      { replacements: { owner, monthKey, seq } }
    );
  }
}

async function saveSyncState({ ownerId, monthKey, sk = {} }) {
  await ensureTables();
  const now = new Date();
  const owner = Number(ownerId);

  let totalMem = num(sk.totalMembers);
  let termMem = num(sk.terminatedMembers);
  let inactMem = num(sk.inactiveMembers);
  const activeBuyers = num(sk.buyers);

  try {
    const dbCounts = await computeTreeCountsCached(owner);
    if (dbCounts && dbCounts.totalCount > 0) {
      totalMem = Math.max(totalMem, dbCounts.totalCount);
      termMem = dbCounts.termCount;
      inactMem = Math.max(0, totalMem - termMem - activeBuyers);
    }
  } catch (e) {
    console.warn(`[rcmActiveView] saveSyncState node count enrichment failed for ${owner}:`, e.message);
  }

  await sequelize.query(
    `INSERT INTO rcm_sync_state
       (owner_id, month_key, state, macro_pv, processed_pv, residual_pv, verified_amt, est_low, est_high,
        total_members, terminated_members, inactive_members,
        buyers, live_nodes, coverage_pct, anomalies, pv_mismatch, verified_at, updated_at)
     VALUES (:owner, :monthKey, :state, :macroPv, :processedPv, :residualPv, :verifiedAmt, :estLow, :estHigh,
        :totalMem, :termMem, :inactMem,
        :buyers, :liveNodes, :coverage, :anomalies, :pvMismatch, :verifiedAt, :now)
     ON DUPLICATE KEY UPDATE
       state = VALUES(state), macro_pv = VALUES(macro_pv), processed_pv = VALUES(processed_pv),
       residual_pv = VALUES(residual_pv), verified_amt = VALUES(verified_amt),
       est_low = VALUES(est_low), est_high = VALUES(est_high),
       total_members = IF(VALUES(total_members) > 0, GREATEST(total_members, VALUES(total_members)), total_members),
       terminated_members = IF(VALUES(total_members) > 0, VALUES(terminated_members), terminated_members),
       inactive_members = IF(VALUES(total_members) > 0, VALUES(inactive_members), inactive_members),
       buyers = VALUES(buyers), live_nodes = VALUES(live_nodes), coverage_pct = VALUES(coverage_pct),
       anomalies = VALUES(anomalies), pv_mismatch = VALUES(pv_mismatch),
       verified_at = IF(VALUES(state) = 'VERIFIED', VALUES(verified_at), verified_at),
       updated_at = VALUES(updated_at)`,
    {
      replacements: {
        owner,
        monthKey,
        state: sk.state || 'BOUNDED',
        macroPv: sk.macroPv || 0,
        processedPv: sk.processedPv || 0,
        residualPv: sk.residualPv || 0,
        verifiedAmt: sk.verifiedAmt || 0,
        estLow: sk.estLow === null || sk.estLow === undefined ? null : sk.estLow,
        estHigh: sk.estHigh === null || sk.estHigh === undefined ? null : sk.estHigh,
        totalMem,
        termMem,
        inactMem,
        buyers: activeBuyers,
        liveNodes: sk.liveNodes || 0,
        coverage: sk.coveragePct || 0,
        anomalies: sk.anomalies || 0,
        pvMismatch: sk.pvMismatch || 0,
        verifiedAt: sk.state === 'VERIFIED' ? now : null,
        now
      }
    }
  );
}

async function getSummary(ownerId, monthKey) {
  await ensureTables();
  const owner = Number(ownerId);

  const [stateRows, legRows] = await Promise.all([
    select('SELECT * FROM rcm_sync_state WHERE owner_id = :owner AND month_key = :monthKey', { owner, monthKey }),
    select(
      `SELECT leg, COUNT(*) AS buyers, SUM(self_pv) AS pv, SUM(amt) AS amt, SUM(amt_known = 0) AS amt_unknown
         FROM rcm_active_view WHERE owner_id = :owner AND month_key = :monthKey GROUP BY leg`,
      { owner, monthKey }
    )
  ]);

  const st = stateRows[0] || null;
  if (!st && legRows.length === 0) return { exists: false, monthKey };

  let buyers = 0;
  let pv = 0;
  let amt = 0;
  let unknown = 0;
  const legs = [];
  for (const r of legRows) {
    buyers += num(r.buyers);
    pv += num(r.pv);
    amt += num(r.amt);
    unknown += num(r.amt_unknown);
    if (r.leg) legs.push({ leg: r.leg, buyers: num(r.buyers), pv: round2(r.pv), amt: round2(r.amt) });
  }
  legs.sort((a, b) => (a.leg < b.leg ? -1 : 1));

  const totalMembers = st ? num(st.total_members) : 0;
  const terminatedMembers = st ? num(st.terminated_members) : 0;
  const inactiveMembers = totalMembers > 0
    ? Math.max(0, totalMembers - terminatedMembers - buyers)
    : (st ? num(st.inactive_members) : 0);

  return {
    exists: true,
    monthKey,
    state: st ? st.state : 'BOUNDED',
    macroPv: st ? round2(st.macro_pv) : null,
    processedPv: st ? round2(st.processed_pv) : null,
    residualPv: st ? round2(st.residual_pv) : null,
    coveragePct: st ? num(st.coverage_pct) : null,
    estLow: st && st.est_low !== null ? round2(st.est_low) : null,
    estHigh: st && st.est_high !== null ? round2(st.est_high) : null,
    verifiedAt: st ? st.verified_at : null,
    updatedAt: st ? st.updated_at : null,
    anomalies: st ? num(st.anomalies) : 0,
    pvMismatch: st ? num(st.pv_mismatch) : 0,
    amtComplete: unknown === 0,
    counts: {
      totalMembers,
      terminatedMembers,
      inactiveMembers,
      activeBuyers: buyers
    },
    totals: { buyers, selfPv: round2(pv), amt: round2(amt) },
    legs
  };
}

const BUCKETS = [
  { key: '10000', label: '10,000+ PV', min: 10000, max: null },
  { key: '5000', label: '5,000 - 9,999 PV', min: 5000, max: 9999.99 },
  { key: '1500', label: '1,500 - 4,999 PV', min: 1500, max: 4999.99 },
  { key: '500', label: '500 - 1,499 PV', min: 500, max: 1499.99 },
  { key: 'low', label: 'Below 500 PV', min: 0.01, max: 499.99 }
];

async function getBuckets({ ownerId, monthKey, leg = null, bucket = null, minPv = null, maxPv = null, limit = 200, offset = 0 }) {
  await ensureTables();
  const owner = Number(ownerId);
  const legCond = leg ? 'AND leg = :leg' : '';
  const base = { owner, monthKey, leg: leg || null };

  const countRows = await select(
    `SELECT COALESCE(leg, '-') AS leg,
            SUM(self_pv >= 10000) AS b10000,
            SUM(self_pv >= 5000 AND self_pv < 10000) AS b5000,
            SUM(self_pv >= 1500 AND self_pv < 5000) AS b1500,
            SUM(self_pv >= 500 AND self_pv < 1500) AS b500,
            SUM(self_pv > 0 AND self_pv < 500) AS blow,
            COUNT(*) AS buyers, SUM(self_pv) AS pv, SUM(amt) AS amt
       FROM rcm_active_view
      WHERE owner_id = :owner AND month_key = :monthKey ${legCond}
      GROUP BY leg`,
    base
  );

  const counts = countRows.map((r) => ({
    leg: r.leg,
    buyers: num(r.buyers),
    pv: round2(r.pv),
    amt: round2(r.amt),
    buckets: {
      '10000': num(r.b10000),
      '5000': num(r.b5000),
      '1500': num(r.b1500),
      '500': num(r.b500),
      low: num(r.blow)
    }
  }));

  let lo = minPv;
  let hi = maxPv;
  if (bucket) {
    const b = BUCKETS.find((x) => x.key === String(bucket));
    if (b) {
      lo = b.min;
      hi = b.max;
    }
  }

  const cond = [];
  const rep = { ...base, limit: Math.min(Math.max(Number(limit) || 200, 1), 1000), offset: Math.max(Number(offset) || 0, 0) };
  if (lo !== null && lo !== undefined && lo !== '') { cond.push('AND self_pv >= :lo'); rep.lo = Number(lo); }
  if (hi !== null && hi !== undefined && hi !== '') { cond.push('AND self_pv <= :hi'); rep.hi = Number(hi); }

  const rows = await select(
    `SELECT buyer_id, parent_id, leg, depth, name, self_pv, amt, amt_known
       FROM rcm_active_view
      WHERE owner_id = :owner AND month_key = :monthKey ${legCond} ${cond.join(' ')}
      ORDER BY self_pv DESC, buyer_id ASC
      LIMIT :limit OFFSET :offset`,
    rep
  );

  return {
    buckets: BUCKETS,
    counts,
    count: rows.length,
    rows: rows.map((r) => ({
      buyer_id: Number(r.buyer_id),
      name: r.name,
      leg: r.leg,
      depth: r.depth,
      self_pv: round2(r.self_pv),
      amt: round2(r.amt),
      amt_known: Boolean(r.amt_known),
      parent_id: r.parent_id === null ? null : Number(r.parent_id)
    }))
  };
}

module.exports = {
  ensureTables,
  replaceOwnerView,
  saveSyncState,
  getSummary,
  getBuckets,
  BUCKETS
};