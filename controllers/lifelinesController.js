'use strict';

const { Op } = require('sequelize');
const { RcmIdentity, RcmMonthlyTurnoverHistory, MemberMonthlySnapshot, sequelize } = require('../models');
const { parseQuery } = require('../utils/queryParser');
const {
  createRcmSession,
  saveSession,
  getSession,
  clearSession
} = require('../services/rcmSessionService');
const rcmGroupScraper = require('../services/rcmGroupScraper');
const { searchLifelineMembers } = require('../utils/treeSearchHelper');
const { emitProgress } = require('../services/socketService');
const { issueToken, revokeToken, allowAttempt, clearAttempts } = require('../services/lifelinesAuth');

/**
 * SCHEMA NOTE:
 * rcm_downline_nodes is a GLOBAL table: one row per RCM buyer_id, no root_buyer_id column.
 * "Whose tree is this" is never a column - it's computed on read via the recursive
 * subtree/ancestors CTEs below, walking parent_id from whichever buyer_id the caller is
 * authorized to see (resolveRoot + isInSubtree). This is intentional: it's what lets an
 * upline's crawl reuse a downline's already-indexed subtree for free, with no duplicate
 * rows and no "grafting" step required.
 */

// ---------------------------------------------------------------------------
// Resilient Scraper & Session Adapters (Zero-crash fallbacks)
// ---------------------------------------------------------------------------
async function persistSessionSafely(buyerId, session) {
  try {
    if (typeof saveSession === 'function') {
      return await saveSession(buyerId, session);
    }
    if (typeof rcmGroupScraper.saveSession === 'function') {
      return await rcmGroupScraper.saveSession(buyerId, session);
    }
    if (session && typeof session.saveSession === 'function') {
      return await session.saveSession();
    }
  } catch (err) {
    console.warn('[SESSION PERSIST NOTICE]:', err.message);
  }
  return null;
}

function retrieveSessionSafely(buyerId) {
  if (typeof getSession === 'function') return getSession(buyerId);
  if (typeof rcmGroupScraper.getSession === 'function') return rcmGroupScraper.getSession(buyerId);
  return null;
}

function removeSessionSafely(buyerId) {
  if (typeof clearSession === 'function') return clearSession(buyerId);
  if (typeof rcmGroupScraper.clearSession === 'function') return rcmGroupScraper.clearSession(buyerId);
  return null;
}

async function fetchMacroSafe(session, buyerId) {
  if (typeof rcmGroupScraper.fetchMacroPvAndProfile === 'function') {
    return await rcmGroupScraper.fetchMacroPvAndProfile(session, buyerId);
  }
  if (typeof rcmGroupScraper.syncOverviewFast === 'function') {
    const overview = await rcmGroupScraper.syncOverviewFast({
      session,
      buyerId,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });
    return {
      identity: {
        name: overview.associateName,
        highest_pin: overview.pinLevel,
        buyer_id: buyerId,
        photo_url: overview.photoUrl
      },
      total_pv: overview.totalPv,
      self_pv: overview.selfPv,
      legs: overview.directLegs,
      ...overview
    };
  }
  if (typeof rcmGroupScraper.scrapeGroupData === 'function') {
    const res = await rcmGroupScraper.scrapeGroupData(session, buyerId);
    return {
      identity: {
        name: res.associateName,
        highest_pin: res.pinLevel,
        buyer_id: buyerId,
        photo_url: res.photoUrl
      },
      total_pv: res.totalPv,
      self_pv: res.selfPv,
      legs: res.members,
      ...res
    };
  }
  return { identity: { buyer_id: buyerId }, total_pv: 0, self_pv: 0 };
}

async function scrapeGroupSafe(session, buyerId, macroInfo) {
  if (typeof rcmGroupScraper.scrapeYourGroup === 'function') {
    return await rcmGroupScraper.scrapeYourGroup(session, buyerId, macroInfo);
  }
  if (typeof rcmGroupScraper.startBackgroundTreeCrawler === 'function') {
    return rcmGroupScraper.startBackgroundTreeCrawler({
      session,
      buyerId,
      directLegs: macroInfo?.legs || macroInfo?.directLegs || [],
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });
  }
}

function getCrawlStatusSafe(rootId) {
  if (typeof rcmGroupScraper.getCrawlStatus === 'function') {
    return rcmGroupScraper.getCrawlStatus(rootId);
  }
  return { running: false, count: 0 };
}

async function fetchChildrenOnDemandSafe(rootId, parentId) {
  if (typeof rcmGroupScraper.fetchChildrenOnDemand === 'function') {
    return await rcmGroupScraper.fetchChildrenOnDemand(rootId, parentId);
  }
  return { fetched: false, count: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeValue(value) {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

const legLabel = (i) => (i < 26 ? String.fromCharCode(65 + i) : `L${i + 1}`);

/** Rolling 12 months, newest first. Key 'YYYYMM', label 'MMM YYYY'. */
function getRolling12Months() {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    });
  }
  return months;
}

/** Current month key and the previous closed month key, computed from the real clock. */
function getCurrentAndClosedMonthKeys() {
  const now = new Date();
  const currentKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const closedKey = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}`;
  return { currentKey, closedKey };
}

function resolveRoot(req, res, suppliedRoot) {
  const tokenRoot = req.lifelinesRoot ? Number(req.lifelinesRoot) : null;
  const supplied = safeNumber(suppliedRoot, 0);
  if (tokenRoot) {
    if (supplied && supplied !== tokenRoot) {
      res.status(403).json({ success: false, message: 'You can only access your own tree.' });
      return null;
    }
    return tokenRoot;
  }
  if (!supplied) {
    res.status(400).json({ success: false, message: 'buyerId is required.' });
    return null;
  }
  return supplied;
}

const select = (sql, replacements = {}) =>
  sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

const SUBTREE_CTE = `
  WITH RECURSIVE subtree (buyer_id, depth) AS (
    SELECT buyer_id, 0 FROM rcm_downline_nodes WHERE buyer_id = :rootId
    UNION ALL
    SELECT n.buyer_id, s.depth + 1
    FROM rcm_downline_nodes n JOIN subtree s ON n.parent_id = s.buyer_id
    WHERE s.depth < 400
  )`;

const NODE_COLS = `n.buyer_id, n.parent_id, n.name, n.status, n.self_pv, n.current_pv, n.repurchase_amt,
  n.total_group_pv, n.level, n.children_count, n.leg_type`;

async function isInSubtree(rootId, memberId) {
  if (!rootId || !memberId) return false;
  if (rootId === memberId) return true;
  const rows = await select(
    `WITH RECURSIVE ancestors (buyer_id, parent_id, depth) AS (
       SELECT buyer_id, parent_id, 0 FROM rcm_downline_nodes WHERE buyer_id = :memberId
       UNION ALL
       SELECT n.buyer_id, n.parent_id, a.depth + 1
       FROM rcm_downline_nodes n JOIN ancestors a ON n.buyer_id = a.parent_id
       WHERE a.depth < 400
     )
     SELECT 1 AS ok FROM ancestors WHERE buyer_id = :rootId LIMIT 1`,
    { rootId, memberId }
  );
  return rows.length > 0;
}

async function getSubtreeIds(rootId, { includeRoot = false } = {}) {
  const rows = await select(
    `${SUBTREE_CTE} SELECT buyer_id FROM subtree ${includeRoot ? '' : 'WHERE depth > 0'}`,
    { rootId }
  );
  return rows.map((r) => Number(r.buyer_id));
}

const IDENTITY_WANTED = [
  'buyer_id', 'name', 'custom_photo_url', 'profile_photo_url', 'photo_url', 'highest_pin', 'pin',
  'kyc_status', 'join_date', 'mobile_no', 'mobile', 'state', 'district', 'tehsil', 'city',
  'post_village', 'pincode', 'address', 'sponsor_id', 'sponsor_name', 'proposer_id', 'proposer_name'
];

async function loadIdentities(ids) {
  const map = new Map();
  if (!ids || ids.length === 0) return map;
  const attributes = IDENTITY_WANTED.filter((a) => RcmIdentity.rawAttributes[a]);
  const rows = await RcmIdentity.findAll({ where: { buyer_id: ids }, attributes, raw: true });
  rows.forEach((r) => map.set(Number(r.buyer_id), r));
  return map;
}

const pickPhoto = (identity = {}) =>
  identity.custom_photo_url || identity.profile_photo_url || identity.photo_url || null;
const pickMobile = (identity = {}) => identity.mobile_no || identity.mobile || '';

function formatNode(node, identity = {}) {
  const selfPv = safeNumber(node.self_pv ?? node.current_pv);
  const childrenCount = safeNumber(node.children_count);
  return {
    id: node.buyer_id,
    buyer_id: node.buyer_id,
    parent_id: node.parent_id,
    name: identity.name || node.name,
    photo_url: pickPhoto(identity),
    highest_pin: identity.highest_pin || 'ASSOCIATE BUYER',
    mobile_no: pickMobile(identity) || null,
    status: Number(node.status),
    statusLabel: Number(node.status) === 1 ? 'ACTIVE' : 'TERMINATED',
    self_pv: selfPv,
    current_pv: selfPv,
    repurchase_amt: safeNumber(node.repurchase_amt),
    total_group_pv: safeNumber(node.total_group_pv),
    children_count: childrenCount,
    has_children: Boolean(Number(node.has_children)) || childrenCount > 0,
    level: node.level
  };
}

// ---------------------------------------------------------------------------
// POST /sync
// ---------------------------------------------------------------------------
exports.syncLifelines = async (req, res) => {
  try {
    const rawId = req.body?.buyerId || req.body?.buyer_id || req.body?.dist_no;
    const password = req.body?.password;
    const buyerId = safeNumber(rawId, 0);

    if (!/^\d{6,10}$/.test(String(buyerId)) || !password) {
      return res.status(400).json({ success: false, message: 'Valid buyerId and password are required.' });
    }

    const idKey = `sync:id:${buyerId}`;
    if (!allowAttempt(`sync:ip:${req.ip}`, 20) || !allowAttempt(idKey, 5)) {
      return res.status(429).json({ success: false, message: 'Too many attempts. Please try again in a few minutes.' });
    }

    const session = createRcmSession({
      buyerId,
      password,
      options: { timeout: 20000, requestDelayMin: 250, requestDelayMax: 400, maxRetries: 2, retryBackoffMs: 500 }
    });

    emitProgress('LIFELINES_SYNC_PROGRESS', {
      buyerId, status: 'starting', percent: 15, isComplete: false,
      message: 'Connecting to RCM Portal and fetching live metrics...'
    });

    try {
      await session.login();
    } catch (loginErr) {
      const msg = String(loginErr?.message || '');
      const isCredentialError = /password|credential|invalid|incorrect|login failed|unauthori/i.test(msg);
      emitProgress('LIFELINES_SYNC_PROGRESS', { buyerId, status: 'error', isComplete: true, message: 'Login failed.' });
      return res.status(isCredentialError ? 401 : 502).json({
        success: false,
        message: isCredentialError ? 'Invalid RCM ID or password.' : 'RCM portal is not reachable right now. Please retry.'
      });
    }

    clearAttempts(idKey);
    await persistSessionSafely(buyerId, session);
    const token = issueToken(buyerId);

    // PHASE 1: instant macro numbers (unlocks the UI)
    const macroInfo = await fetchMacroSafe(session, buyerId);

    res.status(200).json({
      success: true,
      message: 'Instant macro overview unlocked.',
      token,
      buyerId,
      identity: macroInfo?.identity || {},
      macroData: {
        buyer_id: buyerId,
        name: macroInfo.associateName,
        pin: macroInfo.pinLevel,
        photo_url: macroInfo.photoUrl,
        total_pv: macroInfo.totalPv,
        self_pv: macroInfo.selfPv,
        closed_month_pv: macroInfo.closedMonthPv,
        closed_self_pv: macroInfo.closedSelfPv,
        directLegs: macroInfo.directLegs
      }
    });

    // PHASE 2: deep crawl in the background (skips automatically if still fresh - see
    // the TTL guard inside startBackgroundTreeCrawler; this is NOT an unconditional skip)
    setImmediate(async () => {
      try {
        await scrapeGroupSafe(session, buyerId, macroInfo);
      } catch (err) {
        console.error('[BACKGROUND CRAWL ERROR]:', err.message);
        emitProgress('LIFELINES_SYNC_PROGRESS', { buyerId, status: 'error', isComplete: true, message: 'Tree sync failed.' });
      }
    });
    return undefined;
  } catch (error) {
    console.error('Error in syncLifelines:', error.message);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Lifelines sync failed.' });
    }
    return undefined;
  }
};

// POST /logout
exports.logoutLifelines = async (req, res) => {
  if (req.lifelinesRoot) removeSessionSafely(req.lifelinesRoot);
  revokeToken(req.lifelinesToken);
  return res.status(200).json({ success: true });
};

// GET /status/:buyerId
exports.getSyncStatus = async (req, res) => {
  const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
  if (!rootId) return undefined;
  return res.status(200).json({
    success: true,
    data: {
      crawl: getCrawlStatusSafe(rootId),
      hasSession: Boolean(retrieveSessionSafely(rootId))
    }
  });
};

// ---------------------------------------------------------------------------
// GET /overview/:buyerId
// ---------------------------------------------------------------------------
exports.getLifelinesOverview = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const { currentKey, closedKey } = getCurrentAndClosedMonthKeys();

    const [identityMap, rootRows, turnoverCurrent, turnoverClosed, counts, legNodes] = await Promise.all([
      loadIdentities([rootId]),
      select('SELECT * FROM rcm_downline_nodes WHERE buyer_id = :rootId', { rootId }),
      RcmMonthlyTurnoverHistory.findOne({ where: { buyer_id: rootId, year_month: currentKey }, raw: true }).catch(() => null),
      RcmMonthlyTurnoverHistory.findOne({ where: { buyer_id: rootId, year_month: closedKey }, raw: true }).catch(() => null),
      select(
        `${SUBTREE_CTE}
         SELECT COUNT(*) AS total,
                SUM(CASE WHEN n.status = 0 THEN 1 ELSE 0 END) AS terminated_count,
                SUM(CASE WHEN n.self_pv > 0 THEN 1 ELSE 0 END) AS purchasers,
                SUM(CASE WHEN n.status = 1 AND n.self_pv = 0 THEN 1 ELSE 0 END) AS zero_pv
         FROM subtree s JOIN rcm_downline_nodes n ON n.buyer_id = s.buyer_id
         WHERE s.depth > 0`,
        { rootId }
      ),
      select(
        `SELECT ${NODE_COLS},
                EXISTS (SELECT 1 FROM rcm_downline_nodes c WHERE c.parent_id = n.buyer_id) AS has_children
         FROM rcm_downline_nodes n WHERE n.parent_id = :rootId ORDER BY n.buyer_id ASC`,
        { rootId }
      )
    ]);

    const identity = identityMap.get(rootId) || {};
    const rootNode = rootRows[0] || {};
    const c = counts[0] || {};
    const totalTeam = safeNumber(c.total);
    const purchasers = safeNumber(c.purchasers);
    const terminated = safeNumber(c.terminated_count);

    // Live DownlineNode fields are the most current source (updated by every crawl);
    // the turnover history row is the authoritative per-month snapshot once it exists.
    // No hardcoded fallback: an unsynced month genuinely means "no data yet", not a guess.
    const totalPv = safeNumber(turnoverCurrent?.total_pv ?? rootNode.total_group_pv, 0);
    const selfPv = safeNumber(turnoverCurrent?.self_pv ?? rootNode.self_pv ?? rootNode.current_pv, 0);
    const closedTotalPv = turnoverClosed ? safeNumber(turnoverClosed.total_pv) : null;
    const closedSelfPv = turnoverClosed ? safeNumber(turnoverClosed.self_pv) : null;

    const legIdentities = await loadIdentities(legNodes.map((n) => Number(n.buyer_id)));
    const legs = legNodes.map((node, idx) => {
      const legIdentity = legIdentities.get(Number(node.buyer_id)) || {};
      const fallbackPv = idx === 0 ? turnoverCurrent?.leg_a_pv : idx === 1 ? turnoverCurrent?.leg_b_pv : 0;
      return {
        leg: node.leg_type || legLabel(idx),
        head_id: node.buyer_id,
        head_name: legIdentity.name || node.name,
        photo_url: pickPhoto(legIdentity),
        pv: safeNumber(node.total_group_pv || fallbackPv),
        self_pv: safeNumber(node.self_pv),
        repurchase_amt: safeNumber(node.repurchase_amt),
        status: Number(node.status),
        has_children: Boolean(Number(node.has_children))
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        buyerId: rootId,
        buyer_id: rootId,
        synced: Boolean(rootRows.length || turnoverCurrent),
        total_pv: totalPv,
        self_pv: selfPv,
        closed_month_pv: closedTotalPv,   // null until that month is actually synced
        closed_self_pv: closedSelfPv,     // null until that month is actually synced
        total_team: totalTeam,
        active_purchasers: purchasers,
        identity: {
          buyer_id: rootId,
          name: identity.name || rootNode.name || `Associate #${rootId}`,
          highest_pin: identity.highest_pin || null,
          kyc_status: identity.kyc_status || (Number(rootNode.status) === 0 ? 'Terminated' : null),
          photo_url: pickPhoto(identity),
          mobile: pickMobile(identity),
          join_date: identity.join_date || null,
          district: identity.district || null,
          state: identity.state || null
        },
        totals: {
          totalMembers: totalTeam,
          active: purchasers,
          terminated,
          zeroPv: safeNumber(c.zero_pv),
          totalPv,
          selfPv,
          activePurchasers: purchasers
        },
        directLegs: legs,
        legs,
        crawl: getCrawlStatusSafe(rootId)
      }
    });
  } catch (error) {
    console.error('Error in getLifelinesOverview:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch overview.' });
  }
};

// ---------------------------------------------------------------------------
// GET /tree-children
// ---------------------------------------------------------------------------
exports.getLifelinesChildren = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId || req.query.rootBuyerId);
    if (!rootId) return undefined;
    const parentId = safeNumber(req.query.parentId || req.query.parent_id, rootId) || rootId;

    if (!(await isInSubtree(rootId, parentId))) {
      return res.status(404).json({ success: false, message: 'Member not found in your tree.' });
    }

    const childrenSql = `
      SELECT ${NODE_COLS},
             EXISTS (SELECT 1 FROM rcm_downline_nodes c WHERE c.parent_id = n.buyer_id) AS has_children
      FROM rcm_downline_nodes n
      WHERE n.parent_id = :parentId
      ORDER BY n.total_group_pv DESC, n.self_pv DESC, n.buyer_id ASC`;

    let children = await select(childrenSql, { parentId });

    if (children.length === 0 && retrieveSessionSafely(rootId)) {
      const result = await fetchChildrenOnDemandSafe(rootId, parentId);
      if (result.fetched && result.count > 0) children = await select(childrenSql, { parentId });
    }

    const identities = await loadIdentities(children.map((n) => Number(n.buyer_id)));
    const data = children.map((node) => formatNode(node, identities.get(Number(node.buyer_id))));

    return res.status(200).json({
      success: true,
      data,
      meta: {
        parentId,
        crawlRunning: Boolean(getCrawlStatusSafe(rootId)?.running),
        hasSession: Boolean(retrieveSessionSafely(rootId))
      }
    });
  } catch (error) {
    console.error('Error in getLifelinesChildren:', error.message);
    return res.status(200).json({ success: true, data: [], warning: 'Could not load children.' });
  }
};

// ---------------------------------------------------------------------------
// GET /assistant-query
// ---------------------------------------------------------------------------
exports.getAssistantQuery = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.query.buyerId || req.query.rootBuyerId);
    if (!rootId) return undefined;

    const queryString = String(req.query.query || req.query.q || 'all').trim();
    const limit = Math.min(Math.max(safeNumber(req.query.limit, 150), 1), 500);
    const parsed = parseQuery(queryString);
    const rollingMonths = getRolling12Months();
    const monthKeys = rollingMonths.map((m) => m.key);

    const nodes = await select(
      `${SUBTREE_CTE}
       SELECT ${NODE_COLS}, s.depth
       FROM subtree s JOIN rcm_downline_nodes n ON n.buyer_id = s.buyer_id
       WHERE s.depth > 0
       ORDER BY n.self_pv DESC`,
      { rootId }
    );

    if (nodes.length === 0) {
      return res.status(200).json({ success: true, months: rollingMonths.map((m) => m.label), count: 0, data: [] });
    }

    const byId = new Map(nodes.map((n) => [Number(n.buyer_id), n]));
    const heads = nodes.filter((n) => Number(n.depth) === 1).map((n) => Number(n.buyer_id)).sort((a, b) => a - b);
    const headLabel = new Map(heads.map((id, i) => [id, legLabel(i)]));
    const legCache = new Map();
    const legOf = (id) => {
      if (legCache.has(id)) return legCache.get(id);
      let cur = byId.get(id);
      let guard = 0;
      while (cur && Number(cur.depth) > 1 && guard < 500) {
        cur = byId.get(Number(cur.parent_id));
        guard += 1;
      }
      const label = cur ? headLabel.get(Number(cur.buyer_id)) || 'A' : 'A';
      legCache.set(id, label);
      return label;
    };

    const memberIds = nodes.map((n) => Number(n.buyer_id));
    const [snapshots, identityMap] = await Promise.all([
      MemberMonthlySnapshot.findAll({ where: { buyer_id: memberIds, month_key: monthKeys }, raw: true }),
      loadIdentities(memberIds)
    ]);

    const snapshotMap = new Map();
    snapshots.forEach((s) => {
      const id = Number(s.buyer_id);
      if (!snapshotMap.has(id)) snapshotMap.set(id, {});
      snapshotMap.get(id)[String(s.month_key)] = Number(s.pv || 0);
    });

    const rows = [];
    for (const node of nodes) {
      const id = Number(node.buyer_id);
      const identity = identityMap.get(id) || {};
      const snaps = snapshotMap.get(id) || {};
      const monthlyPv = {};
      let totalPv = 0;

      rollingMonths.forEach((m, idx) => {
        const pv = idx === 0
          ? Number(node.self_pv || node.current_pv || snaps[m.key] || 0)
          : Number(snaps[m.key] || 0);
        monthlyPv[m.label] = pv;
        totalPv += pv;
      });

      const currentMonthPv = monthlyPv[rollingMonths[0].label] || 0;
      const row = {
        buyer_id: id,
        parent_id: node.parent_id,
        depth: Number(node.depth),
        name: identity.name || node.name,
        mobile_no: pickMobile(identity) || null,
        district: identity.district || null,
        state: identity.state || null,
        display_wall: identity.highest_pin || (Number(node.status) === 0 ? 'TERMINATED' : 'ASSOCIATE BUYER'),
        leg_type: `Leg ${legOf(id)}`,
        current_month_pv: currentMonthPv,
        repurchase_amt: safeNumber(node.repurchase_amt),
        monthly_pv: monthlyPv,
        total_pv: totalPv,
        status: Number(node.status),
        custom_photo_url: identity.custom_photo_url || null,
        profile_photo_url: identity.profile_photo_url || null,
        photo_url: pickPhoto(identity)
      };

      if (parsed.minPv !== null && row.current_month_pv < parsed.minPv) continue;
      if (parsed.maxPv !== null && row.current_month_pv > parsed.maxPv) continue;
      if (parsed.targetPv !== null && row.current_month_pv !== parsed.targetPv) continue;
      if (parsed.leg && !String(row.leg_type).toUpperCase().includes(String(parsed.leg).toUpperCase())) continue;
      if (parsed.pureConsumers && identity.highest_pin) continue;
      if (queryString.toLowerCase().includes('terminated') && Number(node.status) !== 0) continue;
      rows.push(row);
    }

    return res.status(200).json({
      success: true,
      rootBuyerId: rootId,
      months: rollingMonths.map((m) => m.label),
      count: rows.length,
      data: rows.slice(0, limit)
    });
  } catch (error) {
    console.error('Error in getAssistantQuery:', error.message);
    return res.status(200).json({ success: true, months: [], count: 0, data: [], warning: 'Could not build matrix.' });
  }
};

// ---------------------------------------------------------------------------
// GET /member/:buyerId
// ---------------------------------------------------------------------------
exports.getMemberFullProfile = async (req, res) => {
  try {
    const memberId = safeNumber(req.params.buyerId || req.query.buyerId, 0);
    if (!memberId) return res.status(400).json({ success: false, message: 'buyerId is required.' });

    const rootId = resolveRoot(req, res, req.query.rootBuyerId);
    if (!rootId) return undefined;

    if (!(await isInSubtree(rootId, memberId))) {
      return res.status(404).json({ success: false, message: 'Member not found in your tree.' });
    }

    const [identityMap, nodeRows] = await Promise.all([
      loadIdentities([memberId]),
      select('SELECT * FROM rcm_downline_nodes WHERE buyer_id = :memberId', { memberId })
    ]);
    const identity = identityMap.get(memberId) || null;
    const node = nodeRows[0] || null;

    if (!identity && !node) {
      return res.status(404).json({ success: false, message: 'Member profile not found.' });
    }

    const name = identity?.name || node?.name || `Associate #${memberId}`;
    const selfPv = safeNumber(node?.self_pv ?? node?.current_pv);
    const terminated = node && Number(node.status) === 0;

    return res.status(200).json({
      success: true,
      data: {
        buyer_id: memberId,
        name,
        applicant_name: name,
        join_date: identity?.join_date || null,
        kyc_status: identity?.kyc_status || (terminated ? 'Terminated' : 'Active'),
        highest_pin: identity?.highest_pin || 'ASSOCIATE BUYER',
        pin: identity?.highest_pin || 'ASSOCIATE BUYER',
        sponsor_id: identity?.sponsor_id || node?.parent_id || null,
        sponsor_name: identity?.sponsor_name || null,
        proposer_id: identity?.proposer_id || null,
        proposer_name: identity?.proposer_name || null,
        address_line: identity?.address || null,
        post_village: identity?.post_village || null,
        tehsil: identity?.tehsil || null,
        city: identity?.city || null,
        district: identity?.district || null,
        state: identity?.state || null,
        pincode: identity?.pincode || null,
        mobile: pickMobile(identity || {}),
        mobile_no: pickMobile(identity || {}),
        self_pv: selfPv,
        current_pv: selfPv,
        repurchase_amt: safeNumber(node?.repurchase_amt),
        total_group_pv: safeNumber(node?.total_group_pv),
        children_count: safeNumber(node?.children_count),
        status: node ? Number(node.status) : 1,
        photo_url: pickPhoto(identity || {})
      }
    });
  } catch (error) {
    console.error('Error in getMemberFullProfile:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to load member profile.' });
  }
};

// ---------------------------------------------------------------------------
// GET /search
// ---------------------------------------------------------------------------
exports.searchLifelines = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.query.rootBuyerId || req.query.rootBuyerID || req.query.buyerId);
    if (!rootId) return undefined;
    const searchQuery = req.query.q || req.query.search || req.query.query;
    if (!searchQuery) return res.status(400).json({ success: false, message: 'Search query is required.' });

    const results = await searchLifelineMembers({
      rootBuyerId: rootId,
      searchQuery,
      limit: safeNumber(req.query.limit, 20) || 20
    });
    return res.status(200).json({ success: true, data: results });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to search Lifelines tree.' });
  }
};

// ---------------------------------------------------------------------------
// GET /territory/:buyerId
// ---------------------------------------------------------------------------
exports.getTerritorySummary = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const ids = await getSubtreeIds(rootId, { includeRoot: true });
    const identityMap = await loadIdentities(ids);
    const nodes = await select(
      `${SUBTREE_CTE} SELECT n.buyer_id, n.self_pv FROM subtree s JOIN rcm_downline_nodes n ON n.buyer_id = s.buyer_id`,
      { rootId }
    );
    const pvMap = new Map(nodes.map((n) => [Number(n.buyer_id), safeNumber(n.self_pv)]));
    const identity = identityMap.get(rootId) || {};

    const territoriesMap = {};
    let defaultLocalFocus = null;

    identityMap.forEach((row) => {
      const state = normalizeValue(row.state) || 'Unknown';
      const district = normalizeValue(row.district) || 'Unknown';
      const tehsil = normalizeValue(row.tehsil) || 'Unknown';
      const postVillage = normalizeValue(row.post_village) || 'Unknown';
      const key = `${state}|${district}|${tehsil}|${postVillage}`;

      if (!territoriesMap[key]) {
        territoriesMap[key] = { state, district, tehsil, post_village: postVillage, count: 0, total_pv: 0, members: [] };
      }
      const memberPv = pvMap.get(Number(row.buyer_id)) || 0;
      territoriesMap[key].count += 1;
      territoriesMap[key].total_pv += memberPv;
      territoriesMap[key].members.push({
        buyer_id: row.buyer_id, name: row.name, mobile_no: pickMobile(row) || null, pv: memberPv
      });

      if (identity.district && String(identity.district).toLowerCase() === district.toLowerCase()) {
        if (!defaultLocalFocus || (identity.post_village && String(identity.post_village).toLowerCase() === postVillage.toLowerCase())) {
          defaultLocalFocus = { state, district, tehsil, post_village: postVillage };
        }
      }
    });

    const territoryList = Object.values(territoriesMap)
      .map((entry) => ({
        ...entry,
        priority: entry.post_village === identity.post_village ? 1 : entry.district === identity.district ? 2 : 3
      }))
      .sort((a, b) => a.priority - b.priority || b.total_pv - a.total_pv || b.count - a.count);

    if (!defaultLocalFocus && territoryList.length > 0) defaultLocalFocus = territoryList[0];

    const rows = [...identityMap.values()];
    return res.status(200).json({
      success: true,
      data: {
        buyerId: rootId,
        scopedRoot: rootId,
        default_local_focus: defaultLocalFocus,
        territories: territoryList,
        uniqueStates: [...new Set(rows.map((r) => normalizeValue(r.state)).filter(Boolean))],
        uniqueDistricts: [...new Set(rows.map((r) => normalizeValue(r.district)).filter(Boolean))]
      }
    });
  } catch (error) {
    console.error('Error in getTerritorySummary:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch territory summary.' });
  }
};

// ---------------------------------------------------------------------------
// GET /followup/:buyerId
// ---------------------------------------------------------------------------
exports.getFollowupList = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const rows = await select(
      `${SUBTREE_CTE}
       SELECT ${NODE_COLS}, s.depth
       FROM subtree s JOIN rcm_downline_nodes n ON n.buyer_id = s.buyer_id
       WHERE s.depth > 0 AND n.status = 1 AND n.self_pv = 0
       ORDER BY n.name ASC`,
      { rootId }
    );
    const identityMap = await loadIdentities(rows.map((r) => Number(r.buyer_id)));

    const data = rows.map((node) => {
      const identity = identityMap.get(Number(node.buyer_id)) || {};
      return {
        ...node,
        name: identity.name || node.name,
        current_pv: safeNumber(node.self_pv),
        mobile_no: pickMobile(identity) || null,
        district: identity.district || null,
        state: identity.state || null,
        post_village: identity.post_village || null,
        highest_pin: identity.highest_pin || 'ASSOCIATE BUYER',
        photo_url: pickPhoto(identity)
      };
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Error in getFollowupList:', error.message);
    return res.status(200).json({ success: true, data: [] });
  }
};

// ---------------------------------------------------------------------------
// GET /turnover-history
// ---------------------------------------------------------------------------
exports.getTurnoverHistory = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;
    const rows = await RcmMonthlyTurnoverHistory.findAll({
      where: { buyer_id: rootId },
      order: [['year_month', 'DESC']],
      limit: 12,
      raw: true
    });
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch turnover history.' });
  }
};

// ---------------------------------------------------------------------------
// POST /photo
// ---------------------------------------------------------------------------
exports.updateCustomPhoto = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, null);
    if (!rootId) return undefined;

    const targetId = safeNumber(req.body?.buyerId || req.body?.buyer_id, rootId) || rootId;
    const photoUrl = String(req.body?.custom_photo_url || req.body?.photoUrl || req.body?.photo_url || '').trim();

    if (!photoUrl) return res.status(400).json({ success: false, message: 'custom_photo_url is required.' });
    if (!/^(https?:\/\/|\/uploads\/)/i.test(photoUrl)) {
      return res.status(400).json({ success: false, message: 'Invalid photo URL.' });
    }
    if (!(await isInSubtree(rootId, targetId))) {
      return res.status(403).json({ success: false, message: 'You can only update photos in your own tree.' });
    }

    const member = await RcmIdentity.findByPk(targetId);
    if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

    member.custom_photo_url = photoUrl;
    member.updated_at = new Date();
    await member.save();

    return res.status(200).json({
      success: true,
      message: 'Custom photo updated.',
      data: { buyer_id: targetId, custom_photo_url: photoUrl }
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: 'Failed to update custom photo.' });
  }
};

// Aliases for route compatibility
exports.getOverview = exports.getLifelinesOverview;
exports.getTreeChildren = exports.getLifelinesChildren;
exports.getMemberDetail = exports.getMemberFullProfile;
exports.assistantQuery = exports.getAssistantQuery;