'use strict';

/**
 * rcmGroupScraper.js
 *
 * Stage 1 (syncOverviewFast)        -> root profile + photo + direct legs + dual-month PV
 * Stage 2 (startBackgroundTreeCrawler) -> full downline hierarchy (BFS), hierarchy fields only
 * On-demand (fetchChildrenOnDemand) -> expand a single branch from the UI
 *
 * IMPORTANT DESIGN NOTE (read before changing root_buyer_id behaviour):
 * DownlineNode is a GLOBAL table keyed by buyer_id alone (one row per RCM member,
 * no root_buyer_id column). A member's position in the tree (parent_id, level) does not
 * depend on which user triggered the crawl. This is what makes "subtree grafting" between
 * an upline and a previously-crawled downline root unnecessary: if Unnati was already
 * indexed, her subtree is already shared data, and Leeladhar's own crawl will walk through
 * her node exactly once (skipped if already fresh) and reach her children directly.
 * Ownership / "whose tree can this user see" is a separate authorization concern, enforced
 * at the controller layer via isInSubtree(), not by duplicating rows per root.
 *
 * Load policy toward RCM: low concurrency (max 2 per session), randomized pauses between
 * requests, periodic cooldowns, exponential backoff, and immediate abort when the session
 * has expired. The crawler never retries an expired token.
 */

const axios = require('axios');
let models = {};
try {
  models = require('../models');
} catch (e) {
  console.warn('[MODEL LOAD NOTICE]:', e.message);
}

const { DownlineNode, MemberMonthlySnapshot, RcmIdentity, RcmMonthlyTurnoverHistory } = models;

const ECOM_BASE = 'https://ecomapi.rcmworld.com/api';
const DOWNLINE_API_URL = `${ECOM_BASE}/user/profile/get-distributor-downline`;
const USER_DATA_URL = `${ECOM_BASE}/user/profile/get-user-data`;

// ---- Crawl pacing -----------------------------------------------------------
const CRAWL_CONCURRENCY = 2;                 // max parallel calls per session (1-2)
const NODE_DELAY_MIN_MS = 250;               // jitter between node requests
const NODE_DELAY_MAX_MS = 550;
const COOLDOWN_EVERY_N_FETCHES = 40;         // batch cooldown cadence
const COOLDOWN_MIN_MS = 1500;
const COOLDOWN_MAX_MS = 2500;
const FETCH_TRIES = 3;
const BACKOFF_STEP_MS = 800;

// A node is considered "fresh" for this long before the crawler will walk into it again.
// This is what makes re-login / normal refresh cheap WITHOUT ever serving data that can
// silently go stale forever (unlike an unconditional ">500 nodes => always skip" guard).
const NODE_FRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---- Crawl state (BUG 11) ---------------------------------------------------
// rootBuyerId -> { running, count, failedNodes[], startedAt, finishedAt, error }
const activeCrawls = new Map();

// ---- Helpers ----------------------------------------------------------------
const parseNum = (v) => parseFloat(String(v || '0').replace(/,/g, '').trim()) || 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const jitter = (max = 300) => randomBetween(0, max);

/**
 * BUG 7: safe raw-id extraction. Never falls back to ab_id (that is the parent's id in
 * downline responses) and never turns undefined into the string "undefined".
 */
const getRawId = (obj) => {
  const raw = obj?.dist_no ?? obj?.distno ?? obj?.buyer_id;
  return raw === undefined || raw === null || raw === '' ? null : raw;
};

/**
 * Resilient HTTP GET: preserves session cookies and headers, never throws.
 */
async function safeGet(session, url) {
  try {
    const headers = {
      'Authorization': session?.client?.defaults?.headers?.common['Authorization'] || (session?.token ? `Bearer ${session.token}` : ''),
      'Cookie': session?.client?.defaults?.headers?.common['Cookie'] || '',
      'Origin': 'https://www.rcmworld.com',
      'Referer': 'https://www.rcmworld.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'resource': 'crm',
      'x-user-type': 'ab',
      'Accept': 'application/json, text/plain, */*'
    };

    if (session?.client) {
      return await session.client.get(url, { headers, timeout: 15000, validateStatus: () => true });
    }
    return await axios.get(url, { headers, timeout: 15000, validateStatus: () => true });
  } catch (err) {
    return { status: 500, data: null, error: err.message };
  }
}

/**
 * Extracts the downline array from get-distributor-downline.
 * Primary shape: res.data.data.downlineData
 */
function extractDownlineList(res) {
  if (!res || !res.data) return [];
  const d = res.data;
  if (Array.isArray(d.data?.downlineData)) return d.data.downlineData;
  if (Array.isArray(d.downlineData)) return d.downlineData;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d)) return d;
  return [];
}

/**
 * Extracts the tabular volume array from your-purchase-volume/1.
 */
function extractPurchaseVolumeList(res) {
  if (!res || !res.data) return [];
  const d = res.data;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.data?.members)) return d.data.members;
  return [];
}

/**
 * Reads turnover across inconsistent RCM field keys.
 * your-purchase-volume/profile returns NO turnover fields - only used on
 * your-purchase-volume/1 table rows.
 */
function extractPv(obj) {
  if (!obj) return 0;
  return parseNum(
    obj.tot_pv ||
    obj.purchase_volume ||
    obj.tot_group_pv ||
    obj.group_pv ||
    obj.total_pv ||
    obj.tot_bv ||
    obj.total_bv ||
    obj.pur_vol ||
    obj.pv ||
    0
  );
}

/**
 * BUG 10: status as integer for TiDB. 1 = ACTIVE, 0 = TERMINATED.
 */
function normalizeNumericStatus(item) {
  if (!item) return 1;
  const isTerminated = Boolean(
    item.terminated === true ||
    item.status === 'T' ||
    item.status === 0 ||
    item.status === '0' ||
    item.is_terminated ||
    /terminat/i.test(item.remark || '') ||
    /terminated/i.test(item.title || item.dist_name || item.name || '')
  );
  return isTerminated ? 0 : 1;
}

/**
 * Removes RCM's "Terminated - " prefix and bracketed tags.
 */
function sanitizeName(raw) {
  return String(raw || '')
    .replace(/^terminated\s*-\s*/i, '')
    .replace(/\[.*?\]/g, '')
    .trim();
}

/**
 * Upsert wrapper: errors are logged instead of swallowed (BUG 8).
 */
async function safeUpsert(model, payload, label) {
  if (!model || !model.upsert) return;
  try {
    await model.upsert(payload);
  } catch (err) {
    console.warn(`[DB UPSERT WARN] ${label}:`, err.message);
  }
}

/**
 * Fetches one node's children from get-distributor-downline.
 *  - 401/403        -> throws SESSION_EXPIRED immediately (no retry)
 *  - 200            -> returns the list; an empty array is a genuine leaf
 *  - 429 / 5xx      -> exponential backoff, (attempt * 800ms) + jitter
 *  - other statuses -> throws FETCH_FAILED without retry
 *  - 3 failed tries -> throws FETCH_FAILED
 *
 * UNCHANGED from the previously verified version that indexed the 2,610-node tree.
 */
async function fetchDownline(session, distNo, tries = FETCH_TRIES) {
  let lastStatus = 0;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await safeGet(session, `${DOWNLINE_API_URL}?dist_no=${distNo}`);
    lastStatus = res.status;

    if (res.status === 401 || res.status === 403) {
      throw new Error('SESSION_EXPIRED');
    }
    if (res.status === 200) {
      return extractDownlineList(res);
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) break;

    if (attempt < tries) {
      await sleep(attempt * BACKOFF_STEP_MS + jitter());
    }
  }

  throw new Error(`FETCH_FAILED (HTTP ${lastStatus}) for ${distNo}`);
}

/**
 * Fetches a single month's purchase-volume table rows for a distributor.
 */
async function fetchVolumeTable(session, distNo, month, year) {
  const res = await safeGet(
    session,
    `${ECOM_BASE}/user/business-info/your-purchase-volume/1?distno=${distNo}&month=${month}&year=${year}`
  );
  if (res.status !== 200) {
    console.warn(`[VOLUME] HTTP ${res.status} for ${distNo} ${month}/${year}`);
    return [];
  }
  return extractPurchaseVolumeList(res);
}

/**
 * Finds a table row for a given direct leg, matching by distno first, then by leg label.
 */
function findLegRow(rows, leg) {
  return rows.find((r) => {
    const rid = getRawId(r);
    return rid !== null && String(rid) === leg.distno;
  }) || rows.find((r) => r.leg && leg.leg && String(r.leg).toUpperCase() === String(leg.leg).toUpperCase());
}

/**
 * Fetches identity + profile photo from get-user-data. Tolerant of either endpoint shape.
 */
async function fetchUserProfile(session, distNo) {
  const res = await safeGet(session, `${USER_DATA_URL}?distno=${distNo}`);
  if (res.status !== 200) {
    console.warn(`[USER DATA] HTTP ${res.status} for ${distNo}`);
    return {};
  }
  const d = res.data?.data || res.data || {};
  return {
    name: sanitizeName(d.dist_name || d.name),
    pin_level: d.curr_pin || d.pin_level || null,
    photo_url: d.photo_url || d.profile_photo_url || d.custom_photo_url || null,
    self_pv: d.self_pv || d.current_pv || null
  };
}

/**
 * 1. Stage 1: Fast Sync
 * Hierarchy of direct legs from get-distributor-downline.
 * PV is read strictly from your-purchase-volume/1 (the /profile endpoint carries no
 * turnover fields), for both the current month and the previous closed month.
 * Total PV = Leg A PV + Leg B PV + Self PV.
 */
async function syncOverviewFast({ session, buyerId, month, year }) {
  const now = new Date();
  const currentMonth = month || (now.getMonth() + 1);
  const currentYear = year || now.getFullYear();

  const prevDate = new Date(currentYear, currentMonth - 2, 1);
  const prevMonth = prevDate.getMonth() + 1;
  const prevYear = prevDate.getFullYear();
  const currentMonthKey = `${currentYear}${String(currentMonth).padStart(2, '0')}`;
  const prevMonthKey = `${prevYear}${String(prevMonth).padStart(2, '0')}`;

  console.log(`[FAST SYNC] Starting overview sync for associate: ${buyerId}`);

  // Step A: permanent hierarchy (direct legs) - unrelated to any billing month
  const downlineRes = await safeGet(session, `${DOWNLINE_API_URL}?dist_no=${buyerId}`);
  if (downlineRes.status !== 200) {
    console.warn(`[FAST SYNC] downline API returned HTTP ${downlineRes.status} for ${buyerId}`);
  }
  const downlineList = extractDownlineList(downlineRes);
  console.log(`[FAST SYNC] Extracted ${downlineList.length} direct legs from downlineData for: ${buyerId}`);

  let directLegs = downlineList
    .map((item) => {
      const rawId = getRawId(item);
      if (rawId === null) return null;
      const status = normalizeNumericStatus(item);
      return {
        distno: String(rawId),
        name: sanitizeName(item.title || item.dist_name || item.name),
        status,
        statusLabel: status === 1 ? 'ACTIVE' : 'TERMINATED',
        kyc_status: item.kyc_status || 'OK',
        leg: item.leg || null // BUG 6: never guess A/B from array order
      };
    })
    .filter(Boolean);

  // Step B: identity + photo
  const profile = await fetchUserProfile(session, buyerId);
  const associateName = profile.name || `Associate #${buyerId}`;
  const pinLevel = profile.pin_level || 'ASSOCIATE BUYER';
  const photoUrl = profile.photo_url || null;

  // Step C: both months' turnover tables
  const [currentRows, prevRows] = await Promise.all([
    fetchVolumeTable(session, buyerId, currentMonth, currentYear),
    fetchVolumeTable(session, buyerId, prevMonth, prevYear)
  ]);

  const legA = directLegs.find((l) => l.leg === 'A') || directLegs[0] || null;
  const legB = directLegs.find((l) => l.leg === 'B') || directLegs[1] || null;

  const legPvFor = (rows, leg) => {
    if (!leg) return 0;
    const row = findLegRow(rows, leg);
    return row ? extractPv(row) : 0;
  };

  const selfPvCurrent = parseNum(profile.self_pv);
  const legACurrent = legPvFor(currentRows, legA);
  const legBCurrent = legPvFor(currentRows, legB);
  const totalPvCurrent = legACurrent + legBCurrent + selfPvCurrent;

  // Previous month's self PV isn't on the live profile call; read it off that month's
  // own table rows if the distributor appears there as a self-entry, otherwise 0.
  const selfPvPrevRow = prevRows.find((r) => String(getRawId(r)) === String(buyerId));
  const selfPvPrev = selfPvPrevRow ? parseNum(selfPvPrevRow.self_pv || selfPvPrevRow.current_pv) : 0;
  const legAPrev = legPvFor(prevRows, legA);
  const legBPrev = legPvFor(prevRows, legB);
  const totalPvPrev = legAPrev + legBPrev + selfPvPrev;

  // Attach PV to the direct-leg objects actually fetched (current month only, used to
  // seed level-1 DownlineNode rows below).
  directLegs = directLegs.map((leg) => {
    const row = findLegRow(currentRows, leg);
    return {
      ...leg,
      pv: row ? extractPv(row) : 0,
      self_pv: row ? parseNum(row.self_pv || row.current_pv) : 0,
      pvKnown: Boolean(row)
    };
  });

  console.log(`[FAST SYNC] ${associateName} (${pinLevel}) - Current(${currentMonthKey}) PV: ${totalPvCurrent} - Prev(${prevMonthKey}) PV: ${totalPvPrev}`);

  // Step D: persist
  await safeUpsert(RcmIdentity, {
    buyer_id: String(buyerId),
    name: associateName,
    highest_pin: pinLevel,
    photo_url: photoUrl
  }, 'RcmIdentity');

  await safeUpsert(DownlineNode, {
    buyer_id: String(buyerId),
    parent_id: null,
    name: associateName,
    status: 1,
    self_pv: selfPvCurrent,
    total_group_pv: totalPvCurrent,
    level: 0,
    children_synced_at: new Date() // direct legs were just fetched above
  }, 'DownlineNode root');

  for (const leg of directLegs) {
    const payload = {
      buyer_id: leg.distno,
      parent_id: String(buyerId),
      name: leg.name,
      status: leg.status,
      level: 1
    };
    if (leg.pvKnown) {
      payload.self_pv = leg.self_pv;
      payload.total_group_pv = leg.pv;
    }
    if (leg.leg) payload.leg_type = leg.leg;

    await safeUpsert(DownlineNode, payload, `DownlineNode leg ${leg.distno}`);
  }

  await safeUpsert(MemberMonthlySnapshot, {
    buyer_id: String(buyerId),
    month_key: currentMonthKey,
    month: currentMonth,
    year: currentYear,
    associate_name: associateName,
    pin_level: pinLevel,
    total_pv: totalPvCurrent,
    self_pv: selfPvCurrent,
    last_synced_at: new Date()
  }, 'MemberMonthlySnapshot current');

  await safeUpsert(RcmMonthlyTurnoverHistory, {
    buyer_id: String(buyerId),
    year_month: currentMonthKey,
    total_pv: totalPvCurrent,
    self_pv: selfPvCurrent,
    leg_a_pv: legACurrent,
    leg_b_pv: legBCurrent,
    created_at: new Date()
  }, 'RcmMonthlyTurnoverHistory current');

  await safeUpsert(RcmMonthlyTurnoverHistory, {
    buyer_id: String(buyerId),
    year_month: prevMonthKey,
    total_pv: totalPvPrev,
    self_pv: selfPvPrev,
    leg_a_pv: legAPrev,
    leg_b_pv: legBPrev,
    created_at: new Date()
  }, 'RcmMonthlyTurnoverHistory prev');

  return {
    buyerId,
    associateName,
    pinLevel,
    photoUrl,
    totalPv: totalPvCurrent,
    selfPv: selfPvCurrent,
    closedMonthPv: totalPvPrev,
    closedSelfPv: selfPvPrev,
    activeMonth: currentMonth,
    activeYear: currentYear,
    directLegs
  };
}

/**
 * 2. Stage 2: Background Downline Crawler (BFS over get-distributor-downline)
 *
 * UNCHANGED core queue/visited/fetchDownline logic from the verified 2,610-node crawl.
 * Only addition: a per-root TTL guard so a user that is already freshly indexed does not
 * trigger a redundant RCM crawl on every login. This is NOT an unconditional "skip forever"
 * guard - after NODE_FRESH_MS the root is treated as stale again and re-crawled normally.
 *
 * `month` and `year` stay in the signature for backward compatibility but are unused:
 * the hierarchy is permanent and does not depend on a billing month.
 */
function startBackgroundTreeCrawler({ session, buyerId, directLegs = [], month, year, io, forceFullCrawl = false }) {
  const root = String(buyerId);

  // BUG 11: one crawl per root at a time
  const existing = activeCrawls.get(root);
  if (existing && existing.running) {
    console.log(`[TREE CRAWLER] Crawl already running for ${root}, skipping duplicate start`);
    return getCrawlStatus(root);
  }

  const state = {
    running: true,
    count: directLegs.length,
    failedNodes: [],
    startedAt: new Date(),
    finishedAt: null,
    error: null
  };
  activeCrawls.set(root, state);

  setImmediate(async () => {
    // --- TTL cache-first guard -------------------------------------------------
    // Skips the crawl only if the root's OWN node was synced recently. This never skips
    // based on someone else's crawl, and it re-crawls automatically once stale, so new
    // joins / PV changes are still picked up without hammering RCM on every login.
    if (!forceFullCrawl && DownlineNode && DownlineNode.findOne) {
      try {
        const rootRow = await DownlineNode.findOne({
          where: { buyer_id: root },
          attributes: ['children_synced_at'],
          raw: true
        });
        const syncedAt = rootRow?.children_synced_at ? new Date(rootRow.children_synced_at).getTime() : 0;
        if (syncedAt && Date.now() - syncedAt < NODE_FRESH_MS) {
          console.log(`[TREE CRAWLER] ${root} synced ${Math.round((Date.now() - syncedAt) / 60000)}m ago, still fresh. Skipping RCM crawl.`);
          state.running = false;
          state.finishedAt = new Date();
          if (io) io.to(root).emit('tree:sync-complete', { totalMembers: state.count, cached: true });
          return;
        }
      } catch (err) {
        console.warn('[TREE CRAWLER] freshness check failed, proceeding with crawl:', err.message);
      }
    }

    console.log(`[TREE CRAWLER] Starting BFS indexing for: ${root}`);

    // Start from the direct legs (already saved by Stage 1), or from the root itself
    const queue = directLegs.length > 0
      ? directLegs.map((l) => ({ distNo: String(l.distno), depth: 1 }))
      : [{ distNo: root, depth: 0 }];

    // BUG 1: mark visited at ENQUEUE time, including the initial queue
    const visited = new Set([root, ...queue.map((q) => q.distNo)]);

    let aborted = false;
    let fetchesSinceCooldown = 0;

    const processNode = async (node) => {
      try {
        const children = await fetchDownline(session, node.distNo);

        for (const child of children) {
          const rawId = getRawId(child);                       // BUG 7
          if (rawId === null) continue;
          const childId = String(rawId);
          if (visited.has(childId)) continue;
          visited.add(childId);                                // BUG 1: before any await

          await safeUpsert(DownlineNode, {                     // BUG 4: hierarchy fields only
            buyer_id: childId,
            parent_id: node.distNo,
            name: sanitizeName(child.title || child.dist_name || child.name),
            status: normalizeNumericStatus(child),
            level: node.depth + 1
          }, `DownlineNode ${childId}`);

          state.count++;
          queue.push({ distNo: childId, depth: node.depth + 1 });
        }

        // Mark this node's own children as freshly synced (used by the TTL guard above).
        if (DownlineNode && DownlineNode.update) {
          await DownlineNode.update(
            { children_synced_at: new Date() },
            { where: { buyer_id: String(node.distNo) } }
          ).catch((err) => console.warn(`[FRESHNESS UPDATE WARN] ${node.distNo}:`, err.message));
        }
      } catch (err) {
        if (err.message === 'SESSION_EXPIRED') {
          aborted = true;
          state.error = 'SESSION_EXPIRED';
        } else {
          state.failedNodes.push(node.distNo);
          console.warn(`[TREE CRAWLER WARN] Node ${node.distNo}:`, err.message);
        }
      }
    };

    try {
      while (queue.length > 0 && !aborted) {
        const batch = queue.splice(0, CRAWL_CONCURRENCY);
        await Promise.all(batch.map(processNode));

        fetchesSinceCooldown += batch.length;

        if (io) {
          io.to(root).emit('tree:sync-progress', { syncedCount: state.count, status: 'IN_PROGRESS' });
        }

        if (fetchesSinceCooldown >= COOLDOWN_EVERY_N_FETCHES) {
          fetchesSinceCooldown = 0;
          await sleep(randomBetween(COOLDOWN_MIN_MS, COOLDOWN_MAX_MS));
        } else {
          await sleep(randomBetween(NODE_DELAY_MIN_MS, NODE_DELAY_MAX_MS));
        }
      }
    } catch (err) {
      state.error = err.message;
      console.error('[TREE CRAWLER ERROR]:', err.message);
    }

    // BUG 11: release the lock on complete, error, or session abort
    state.running = false;
    state.finishedAt = new Date();

    if (state.error) {
      console.warn(`[TREE CRAWLER ABORTED] ${root}: ${state.error} (${state.count} nodes indexed)`);
      if (io) {
        io.to(root).emit('tree:sync-error', {
          reason: state.error,
          syncedCount: state.count,
          failedNodes: state.failedNodes.length
        });
      }
    } else {
      console.log(`[TREE CRAWLER COMPLETE] ${state.count} nodes indexed for ${root} (${state.failedNodes.length} failed)`);
      if (io) {
        io.to(root).emit('tree:sync-complete', {
          totalMembers: state.count,
          failedNodes: state.failedNodes.length
        });
      }
    }
  });

  return getCrawlStatus(root);
}

/**
 * 3. On-Demand Branch Expansion (UI "+" click)
 */
async function fetchChildrenOnDemand(rootId, parentId) {
  try {
    const { getSession } = require('./rcmSessionService');
    const session = getSession(rootId);
    if (!session) return { fetched: false, count: 0 };

    // BUG 9: derive child level from the parent's stored level (global table, no root scoping)
    let parentLevel = 0;
    if (DownlineNode && DownlineNode.findOne) {
      const parentRow = await DownlineNode.findOne({
        where: { buyer_id: String(parentId) },
        attributes: ['level'],
        raw: true
      }).catch((err) => {
        console.warn('[DB LOOKUP WARN] parent level:', err.message);
        return null;
      });
      parentLevel = parentRow?.level || 0;
    }

    // BUG 2/3: hierarchy comes only from get-distributor-downline, no purchase-volume fallback
    const children = await fetchDownline(session, parentId);

    let saved = 0;
    for (const child of children) {
      const rawId = getRawId(child);                         // BUG 7
      if (rawId === null) continue;

      await safeUpsert(DownlineNode, {                       // BUG 4: hierarchy fields only
        buyer_id: String(rawId),
        parent_id: String(parentId),
        name: sanitizeName(child.title || child.dist_name || child.name),
        status: normalizeNumericStatus(child),
        level: parentLevel + 1
      }, `DownlineNode ${rawId}`);
      saved++;
    }

    if (DownlineNode && DownlineNode.update) {
      await DownlineNode.update(
        { children_synced_at: new Date() },
        { where: { buyer_id: String(parentId) } }
      ).catch(() => null);
    }

    return { fetched: true, count: saved };
  } catch (err) {
    console.warn('[FETCH CHILDREN WARN]:', err.message);
    return { fetched: false, count: 0, reason: err.message === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : undefined };
  }
}

async function fetchMacroPvAndProfile(session, buyerId) {
  const overview = await syncOverviewFast({ session, buyerId });
  return {
    identity: {
      buyer_id: buyerId,
      name: overview.associateName,
      highest_pin: overview.pinLevel,
      photo_url: overview.photoUrl
    },
    total_pv: overview.totalPv,
    self_pv: overview.selfPv,
    legs: overview.directLegs,
    ...overview
  };
}

async function scrapeYourGroup(session, buyerId, macroInfo) {
  return startBackgroundTreeCrawler({
    session,
    buyerId,
    directLegs: macroInfo?.directLegs || macroInfo?.legs || []
  });
}

/**
 * BUG 11: real crawl state from activeCrawls.
 */
function getCrawlStatus(rootId) {
  const state = activeCrawls.get(String(rootId));
  if (!state) return { running: false, count: 0 };
  return {
    running: state.running,
    count: state.count,
    failedNodes: state.failedNodes.length,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error
  };
}

module.exports = {
  syncOverviewFast,
  startBackgroundTreeCrawler,
  fetchMacroPvAndProfile,
  scrapeYourGroup,
  getCrawlStatus,
  fetchChildrenOnDemand,
  scrapeGroupData: syncOverviewFast,
  syncGroupData: syncOverviewFast
};