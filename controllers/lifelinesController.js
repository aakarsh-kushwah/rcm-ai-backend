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
        curr_pin: overview.currPin,
        highest_pin: overview.maxPin,
        buyer_id: buyerId,
        photo_url: overview.photoUrl,
        kyc_status: overview.kycStatus,
        join_date: overview.joinDate
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
  return undefined;
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
// Generic helpers
// ---------------------------------------------------------------------------
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstPositive(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeValue(value) {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const legLabel = (i) => (i < 26 ? String.fromCharCode(65 + i) : `L${i + 1}`);

const monthKeyOf = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabelOf = (d) => d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

/** Current month key and previous closed month key, from the real clock (YYYYMM). */
function getCurrentAndClosedMonthKeys() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { currentKey: monthKeyOf(now), closedKey: monthKeyOf(prev) };
}

/** Token owner is ALWAYS the root. A different buyerId in the URL is rejected. */
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

// ---------------------------------------------------------------------------
// Identity loader (only columns that really exist on the model)
// ---------------------------------------------------------------------------
const IDENTITY_WANTED = [
  'buyer_id', 'name', 'custom_photo_url', 'profile_photo_url', 'photo_url',
  'highest_pin', 'pin', 'curr_pin', 'max_pin',
  'kyc_status', 'join_date', 'mobile_no', 'mobile', 'state', 'district', 'tehsil', 'city',
  'post_village', 'pincode', 'address', 'sponsor_id', 'sponsor_name', 'proposer_id', 'proposer_name'
];

async function loadIdentities(ids) {
  const map = new Map();
  if (!ids || ids.length === 0) return map;
  const attributes = IDENTITY_WANTED.filter((a) => RcmIdentity.rawAttributes[a]);
  for (const part of chunk(ids, 2000)) {
    const rows = await RcmIdentity.findAll({ where: { buyer_id: part }, attributes, raw: true });
    rows.forEach((r) => map.set(Number(r.buyer_id), r));
  }
  return map;
}

const pickPhoto = (identity = {}) =>
  identity.custom_photo_url || identity.profile_photo_url || identity.photo_url || null;
const pickMobile = (identity = {}) => identity.mobile_no || identity.mobile || '';
const pickPin = (identity = {}) =>
  identity.max_pin || identity.highest_pin || identity.curr_pin || identity.pin || null;

// ---------------------------------------------------------------------------
// TREE ENGINE: Ultra-Fast Single Query & In-Memory BFS
// ---------------------------------------------------------------------------
const NODE_COLUMN_CANDIDATES = [
  'buyer_id', 'parent_id', 'name', 'status', 'kyc_status', 'leg_type', 'level',
  'current_pv', 'self_pv', 'repurchase_amt', 'purchase_amt', 'total_group_pv', 'children_count'
];
const TREE_TTL_MS = 10 * 1000;
const TREE_MIN_RELOAD_MS = 2 * 1000;
const MAX_TREE_DEPTH = 5000;
const MAX_TREE_NODES = 300000;
const MAX_CACHED_TREES = 20;

let nodeColumnsPromise = null;
function getNodeColumns() {
  if (!nodeColumnsPromise) {
    nodeColumnsPromise = sequelize.getQueryInterface().describeTable('rcm_downline_nodes')
      .then((desc) => {
        const cols = NODE_COLUMN_CANDIDATES.filter((c) => desc[c]);
        if (!cols.includes('buyer_id') || !cols.includes('parent_id')) {
          throw new Error('rcm_downline_nodes must have buyer_id and parent_id columns.');
        }
        return cols;
      })
      .catch((err) => {
        nodeColumnsPromise = null;
        throw err;
      });
  }
  return nodeColumnsPromise;
}

const columnSql = (cols) => cols.map((c) => `\`${c}\``).join(', ');

function normalizeNode(row, depth) {
  const selfPv = safeNumber(firstDefined(row.self_pv, row.current_pv));
  return {
    buyer_id: Number(row.buyer_id),
    parent_id: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
    name: row.name || null,
    status: Number(row.status ?? 1),
    kyc_status: row.kyc_status || null,
    leg_type: row.leg_type || null,
    level: row.level,
    self_pv: selfPv,
    pv: Math.max(safeNumber(row.current_pv), safeNumber(row.self_pv)),
    repurchase_amt: Math.max(safeNumber(row.repurchase_amt), safeNumber(row.purchase_amt)),
    total_group_pv: safeNumber(row.total_group_pv),
    children_count: safeNumber(row.children_count),
    depth
  };
}

async function fetchSubtreeFromDb(rootId) {
  const cols = columnSql(await getNodeColumns());
  const nodeMap = new Map();
  const childrenMap = new Map();

  // Single fast query loads all tree records (takes ~50ms)
  const allRows = await select(`SELECT ${cols} FROM rcm_downline_nodes`);
  for (const row of allRows) {
    const key = String(row.buyer_id);
    const node = normalizeNode(row, 0);
    nodeMap.set(key, node);
    if (row.parent_id !== null && row.parent_id !== undefined) {
      const parentKey = String(row.parent_id);
      if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
      childrenMap.get(parentKey).push(node);
    }
  }

  const rootKey = String(rootId);
  if (!nodeMap.has(rootKey)) {
    return { nodeMap: new Map(), childrenMap: new Map(), builtAt: Date.now(), truncated: false };
  }

  // RAM BFS filter: extract only rootId's subtree (< 10ms)
  const subtreeNodeMap = new Map();
  const subtreeChildrenMap = new Map();
  const queue = [{ id: rootKey, depth: 0 }];
  const visited = new Set();

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    const node = nodeMap.get(id);
    if (node) {
      node.depth = depth;
      subtreeNodeMap.set(id, node);
    }

    const kids = childrenMap.get(id);
    if (kids) {
      subtreeChildrenMap.set(id, kids);
      for (const kid of kids) {
        const kidId = String(kid.buyer_id);
        if (!visited.has(kidId)) {
          queue.push({ id: kidId, depth: depth + 1 });
        }
      }
    }
  }

  return { nodeMap: subtreeNodeMap, childrenMap: subtreeChildrenMap, builtAt: Date.now(), truncated: false };
}

const treeCache = new Map();

function invalidateTree(rootId) {
  treeCache.delete(String(rootId));
}

function loadTree(rootId, { fresh = false } = {}) {
  const key = String(rootId);
  const hit = treeCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (fresh ? age < TREE_MIN_RELOAD_MS : age < TREE_TTL_MS)) return hit.promise;

  if (treeCache.size >= MAX_CACHED_TREES) {
    for (const [k, v] of treeCache) {
      if (Date.now() - v.at >= TREE_TTL_MS) treeCache.delete(k);
    }
    if (treeCache.size >= MAX_CACHED_TREES) treeCache.delete(treeCache.keys().next().value);
  }

  const promise = fetchSubtreeFromDb(Number(rootId)).catch((err) => {
    treeCache.delete(key);
    throw err;
  });
  treeCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function isInSubtree(rootId, memberId) {
  const r = Number(rootId);
  const m = Number(memberId);
  if (!r || !m) return false;
  if (r === m) return true;
  let tree = await loadTree(r);
  if (tree.nodeMap.has(String(m))) return true;
  tree = await loadTree(r, { fresh: true });
  return tree.nodeMap.has(String(m));
}

function classifyNode(node) {
  if (Number(node.status) === 0) return 'terminated';
  if (node.pv > 0 || node.repurchase_amt > 0) return 'active';
  return 'inactive';
}

function analyzeTree(tree, rootId) {
  const rootKey = String(rootId);
  const rootNode = tree.nodeMap.get(rootKey) || null;
  const heads = (tree.childrenMap.get(rootKey) || []).slice().sort((a, b) => a.buyer_id - b.buyer_id);

  const totals = { members: 0, active: 0, inactive: 0, terminated: 0, pv: 0, repurchase: 0 };
  const members = [];
  const visited = new Set([rootKey]);

  const legs = heads.map((head, idx) => {
    const leg = {
      head,
      letter: legLabel(idx),
      members: 0, active: 0, inactive: 0, terminated: 0, pv: 0, repurchase: 0
    };

    const queue = [{ node: head, depth: 1 }];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const { node, depth } = queue[qi];
      const key = String(node.buyer_id);
      if (visited.has(key)) continue;
      visited.add(key);

      const kind = classifyNode(node);
      leg.members += 1;
      leg[kind] += 1;
      leg.pv += node.pv;
      leg.repurchase += node.repurchase_amt;

      totals.members += 1;
      totals[kind] += 1;
      totals.pv += node.pv;
      totals.repurchase += node.repurchase_amt;

      members.push({ ...node, depth, leg_letter: leg.letter, leg_type: `Leg ${leg.letter}`, kind });

      const kids = tree.childrenMap.get(key);
      if (kids) {
        for (const child of kids) {
          if (!visited.has(String(child.buyer_id))) queue.push({ node: child, depth: depth + 1 });
        }
      }
    }
    return leg;
  });

  return { rootNode, legs, members, totals };
}

// ---------------------------------------------------------------------------
// Direct SQL for fresh single-parent reads
// ---------------------------------------------------------------------------
async function fetchChildrenRows(parentId) {
  const cols = columnSql(await getNodeColumns());
  const rows = await select(`SELECT ${cols} FROM rcm_downline_nodes WHERE parent_id = :parentId`, { parentId });
  const nodes = rows.map((r) => normalizeNode(r, 0));
  nodes.sort((a, b) =>
    b.total_group_pv - a.total_group_pv || b.pv - a.pv || a.buyer_id - b.buyer_id);

  const withKids = new Set();
  if (nodes.length > 0) {
    const kidRows = await select(
      'SELECT DISTINCT parent_id FROM rcm_downline_nodes WHERE parent_id IN (:ids)',
      { ids: nodes.map((n) => n.buyer_id) }
    );
    kidRows.forEach((r) => withKids.add(Number(r.parent_id)));
  }
  return nodes.map((n) => ({ ...n, has_children: withKids.has(n.buyer_id) }));
}

function formatNode(node, identity = {}) {
  return {
    id: node.buyer_id,
    buyer_id: node.buyer_id,
    parent_id: node.parent_id,
    name: identity.name || node.name,
    photo_url: pickPhoto(identity),
    curr_pin: identity.curr_pin || identity.pin || 'ASSOCIATE BUYER',
    max_pin: identity.max_pin || identity.highest_pin || 'ASSOCIATE BUYER',
    highest_pin: identity.highest_pin || 'ASSOCIATE BUYER',
    kyc_status: node.kyc_status || identity.kyc_status || (Number(node.status) === 0 ? 'Terminated' : null),
    join_date: identity.join_date || null,
    mobile_no: pickMobile(identity) || null,
    status: Number(node.status),
    statusLabel: Number(node.status) === 1 ? 'ACTIVE' : 'TERMINATED',
    self_pv: node.self_pv,
    current_pv: node.self_pv,
    repurchase_amt: node.repurchase_amt,
    total_group_pv: node.total_group_pv,
    children_count: node.children_count,
    has_children: Boolean(node.has_children) || node.children_count > 0,
    level: node.level
  };
}

// ---------------------------------------------------------------------------
// Turnover history helpers
// ---------------------------------------------------------------------------
const rowMonthKey = (row) => String(row.month_key || row.year_month || '').replace('-', '');

async function fetchTurnoverRows(buyerId, limit = 12) {
  const attrs = RcmMonthlyTurnoverHistory.rawAttributes || {};
  const orderCol = attrs.year_month ? 'year_month' : attrs.month_key ? 'month_key' : null;
  return RcmMonthlyTurnoverHistory.findAll({
    where: { buyer_id: buyerId },
    ...(orderCol ? { order: [[orderCol, 'DESC']] } : {}),
    limit,
    raw: true
  });
}

// ---------------------------------------------------------------------------
// POST /sync
// ---------------------------------------------------------------------------
exports.syncLifelines = async (req, res) => {
  try {
    const rawId = req.body?.buyerId || req.body?.buyer_id || req.body?.dist_no || req.body?.distNo || req.body?.rcmId || req.body?.id;
    const password = req.body?.password || req.body?.rcmPassword || req.body?.pass;
    const buyerId = safeNumber(rawId, 0);

    // Single backslash regex check
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
    invalidateTree(buyerId);
    const token = issueToken(buyerId);

    const macroInfo = await fetchMacroSafe(session, buyerId);

    res.status(200).json({
      success: true,
      message: 'Instant macro overview unlocked.',
      token,
      lifelinesToken: token,
      buyerId,
      identity: macroInfo?.identity || {},
      macroData: {
        buyer_id: buyerId,
        name: macroInfo.associateName,
        curr_pin: macroInfo.currPin,
        max_pin: macroInfo.maxPin,
        photo_url: macroInfo.photoUrl,
        kyc_status: macroInfo.kycStatus,
        join_date: macroInfo.joinDate,
        total_pv: firstDefined(macroInfo.totalPv, macroInfo.total_pv),
        self_pv: firstDefined(macroInfo.selfPv, macroInfo.self_pv),
        closed_month_pv: macroInfo.closedMonthPv,
        closed_self_pv: macroInfo.closedSelfPv,
        directLegs: macroInfo.directLegs || macroInfo.legs
      }
    });

    setImmediate(async () => {
      try {
        await scrapeGroupSafe(session, buyerId, macroInfo);
      } catch (err) {
        console.error('[BACKGROUND CRAWL ERROR]:', err.message);
        emitProgress('LIFELINES_SYNC_PROGRESS', { buyerId, status: 'error', isComplete: true, message: 'Tree sync failed.' });
      } finally {
        invalidateTree(buyerId);
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

exports.logoutLifelines = async (req, res) => {
  if (req.lifelinesRoot) {
    removeSessionSafely(req.lifelinesRoot);
    invalidateTree(req.lifelinesRoot);
  }
  revokeToken(req.lifelinesToken);
  return res.status(200).json({ success: true });
};

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

    const [identityMap, tree, historyRows] = await Promise.all([
      loadIdentities([rootId]),
      loadTree(rootId),
      fetchTurnoverRows(rootId, 12).catch(() => [])
    ]);

    const identity = identityMap.get(rootId) || {};
    const analysis = analyzeTree(tree, rootId);
    const { rootNode, legs, totals } = analysis;

    const turnoverCurrent = historyRows.find((h) => rowMonthKey(h) === currentKey) || null;
    const turnoverClosed = historyRows.find((h) => rowMonthKey(h) === closedKey) || null;

    const selfRepurchaseAmt = rootNode ? rootNode.repurchase_amt : 0;
    const selfPv = firstPositive(turnoverCurrent?.self_pv, rootNode?.self_pv);
    const totalPv = firstPositive(turnoverCurrent?.total_pv, rootNode?.total_group_pv, totals.pv + selfPv);
    const totalTeamRepurchaseAmt = totals.repurchase + selfRepurchaseAmt;

    const legIdentities = await loadIdentities(legs.map((l) => l.head.buyer_id));

    const directLegs = legs.map((leg, idx) => {
      const head = leg.head;
      const legIdentity = legIdentities.get(head.buyer_id) || {};
      const turnoverLegPv = idx === 0 ? safeNumber(turnoverCurrent?.leg_a_pv) : idx === 1 ? safeNumber(turnoverCurrent?.leg_b_pv) : 0;
      const officialPv = firstPositive(head.total_group_pv, turnoverLegPv, leg.pv);
      const subtreeRepurchase = leg.repurchase;
      const name = legIdentity.name || head.name;

      return {
        distno: head.buyer_id,
        buyer_id: head.buyer_id,
        head_id: head.buyer_id,
        name,
        head_name: name,
        leg: leg.letter,
        leg_type: `Leg ${leg.letter}`,
        photo_url: pickPhoto(legIdentity),
        pv: officialPv,
        subtree_pv: officialPv,
        total_leg_subtree_pv: officialPv,
        crawled_pv: leg.pv,
        self_pv: head.self_pv,
        repurchase_amt: subtreeRepurchase,
        total_leg_repurchase_amt: subtreeRepurchase,
        subtree_repurchase_amt: subtreeRepurchase,
        self_repurchase_amt: head.repurchase_amt,
        members: leg.members,
        active_purchasers: leg.active,
        inactive_members: leg.inactive,
        terminated_members: leg.terminated,
        status: head.status,
        has_children: (tree.childrenMap.get(String(head.buyer_id)) || []).length > 0
      };
    });

    const monthlyHistory = [];
    const now = new Date();
    for (let i = 0; i < 3; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = monthKeyOf(d);
      const hist = i === 0 ? turnoverCurrent : historyRows.find((h) => rowMonthKey(h) === key) || null;
      const hasData = i === 0 || Boolean(hist);
      monthlyHistory.push({
        monthKey: key,
        monthLabel: monthLabelOf(d),
        isCurrent: i === 0,
        hasData,
        totalPv: i === 0 ? totalPv : (hist ? safeNumber(hist.total_pv) : null),
        selfPv: i === 0 ? selfPv : (hist ? safeNumber(hist.self_pv) : null),
        legAPv: i === 0 ? (directLegs[0]?.pv ?? 0) : (hist ? safeNumber(hist.leg_a_pv) : null),
        legBPv: i === 0 ? (directLegs[1]?.pv ?? 0) : (hist ? safeNumber(hist.leg_b_pv) : null)
      });
    }

    const officialPin = pickPin(identity);
    const profilePic = pickPhoto(identity);
    const displayName = identity.name || rootNode?.name || `Associate #${rootId}`;
    const closedTotalPv = turnoverClosed ? safeNumber(turnoverClosed.total_pv) : null;
    const closedSelfPv = turnoverClosed ? safeNumber(turnoverClosed.self_pv) : null;

    return res.status(200).json({
      success: true,
      data: {
        buyerId: rootId,
        buyer_id: rootId,
        name: displayName,
        associateName: displayName,
        pinLevel: officialPin,
        currPin: identity.curr_pin || null,
        maxPin: identity.max_pin || identity.highest_pin || null,
        curr_pin: identity.curr_pin || null,
        max_pin: identity.max_pin || identity.highest_pin || null,
        highest_pin: officialPin,
        photo_url: profilePic,
        photoUrl: profilePic,
        synced: Boolean(rootNode || turnoverCurrent),
        treeTruncated: Boolean(tree.truncated),
        total_pv: totalPv,
        totalPv,
        self_pv: selfPv,
        selfPv,
        self_repurchase_amt: selfRepurchaseAmt,
        selfRepurchaseAmt,
        total_repurchase_amt: totalTeamRepurchaseAmt,
        total_team_repurchase_amt: totalTeamRepurchaseAmt,
        totalTeamRepurchaseAmt,
        closed_month_pv: closedTotalPv,
        closed_self_pv: closedSelfPv,
        total_team: totals.members,
        active_purchasers: totals.active,
        inactive_members: totals.inactive,
        terminated_members: totals.terminated,
        identity: {
          buyer_id: rootId,
          name: displayName,
          curr_pin: identity.curr_pin || null,
          max_pin: identity.max_pin || identity.highest_pin || null,
          highest_pin: officialPin,
          pinLevel: officialPin,
          kyc_status: identity.kyc_status || rootNode?.kyc_status || (rootNode && rootNode.status === 0 ? 'Terminated' : null),
          photo_url: profilePic,
          photoUrl: profilePic,
          mobile: pickMobile(identity),
          join_date: identity.join_date || null,
          district: identity.district || null,
          state: identity.state || null
        },
        totals: {
          totalMembers: totals.members,
          active: totals.active,
          inactive: totals.inactive,
          terminated: totals.terminated,
          zeroPv: totals.inactive,
          totalPv,
          selfPv,
          totalRepurchaseAmt: totalTeamRepurchaseAmt,
          activePurchasers: totals.active
        },
        directLegs,
        legs: directLegs,
        monthlyHistory,
        crawl: getCrawlStatusSafe(rootId)
      }
    });
  } catch (error) {
    console.error('Error in getLifelinesOverview:', error.message);
    return res.status(500).json({ success: false, code: 'OVERVIEW_FAILED', message: 'Could not build the overview. Please retry.' });
  }
};

// ---------------------------------------------------------------------------
// GET /tree-children  |  GET /children/:buyerId
// ---------------------------------------------------------------------------
exports.getLifelinesChildren = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId || req.query.rootBuyerId);
    if (!rootId) return undefined;
    const parentId = safeNumber(req.query.parentId || req.query.parent_id, rootId) || rootId;

    if (!(await isInSubtree(rootId, parentId))) {
      return res.status(404).json({ success: false, message: 'Member not found in your tree.' });
    }

    let rows = await fetchChildrenRows(parentId);

    if (rows.length === 0 && retrieveSessionSafely(rootId)) {
      const result = await fetchChildrenOnDemandSafe(rootId, parentId);
      if (result?.fetched && result.count > 0) {
        rows = await fetchChildrenRows(parentId);
        invalidateTree(rootId);
      }
    }

    const identities = await loadIdentities(rows.map((n) => n.buyer_id));
    const data = rows.map((node) => formatNode(node, identities.get(node.buyer_id)));

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
    const requestedMonthKey = String(req.query.monthKey || req.query.month_key || '').trim();
    const limit = Math.min(Math.max(safeNumber(req.query.limit, 150), 1), 500);
    const monthCount = Math.min(Math.max(Math.floor(safeNumber(req.query.months, 3)), 1), 12);
    const parsed = parseQuery(queryString) || {};

    const legRaw = req.query.leg || parsed.leg || '';
    const legFilter = String(legRaw).toUpperCase().replace(/^LEG\s*/, '').trim();

    let baseDate = new Date();
    if (/^\d{6}$/.test(requestedMonthKey)) {
      baseDate = new Date(parseInt(requestedMonthKey.slice(0, 4), 10), parseInt(requestedMonthKey.slice(4, 6), 10) - 1, 1);
    }

    const dynamicMonths = [];
    for (let i = 0; i < monthCount; i += 1) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
      dynamicMonths.push({
        key: monthKeyOf(d),
        label: `${monthLabelOf(d)} (${i === 0 ? 'Current / Live' : 'Closed'})`
      });
    }
    const monthKeys = dynamicMonths.map((m) => m.key);
    const monthLabels = dynamicMonths.map((m) => m.label);

    const tree = await loadTree(rootId);
    const { members } = analyzeTree(tree, rootId);

    if (members.length === 0) {
      return res.status(200).json({ success: true, months: monthLabels, monthKeys, count: 0, data: [] });
    }

    const memberIds = members.map((n) => n.buyer_id);
    const snapshotMap = new Map();

    const [identityMap] = await Promise.all([
      loadIdentities(memberIds),
      (async () => {
        for (const part of chunk(memberIds, 5000)) {
          const snaps = await MemberMonthlySnapshot.findAll({
            where: { buyer_id: part, month_key: monthKeys },
            raw: true
          }).catch(() => []);
          snaps.forEach((s) => {
            const id = Number(s.buyer_id);
            if (!snapshotMap.has(id)) snapshotMap.set(id, {});
            snapshotMap.get(id)[String(s.month_key)] = {
              pv: safeNumber(firstDefined(s.pv, s.self_pv, s.current_pv)),
              purchase_amt: safeNumber(firstDefined(s.purchase_amt, s.repurchase_amt))
            };
          });
        }
      })()
    ]);

    const wantsTerminated = queryString.toLowerCase().includes('terminated');
    const rows = [];

    for (const node of members) {
      const identity = identityMap.get(node.buyer_id) || {};
      const snaps = snapshotMap.get(node.buyer_id) || {};
      const monthlyPv = {};
      const monthlyPurchaseAmt = {};
      let totalPv = 0;

      dynamicMonths.forEach((m, idx) => {
        const snap = snaps[m.key];
        const pv = idx === 0 ? firstPositive(node.pv, snap?.pv) : safeNumber(snap?.pv);
        const amt = idx === 0 ? firstPositive(node.repurchase_amt, snap?.purchase_amt) : safeNumber(snap?.purchase_amt);
        monthlyPv[m.label] = pv;
        monthlyPurchaseAmt[m.label] = amt;
        totalPv += pv;
      });

      const currentMonthPv = monthlyPv[dynamicMonths[0].label] || 0;

      if (legFilter && node.leg_letter !== legFilter) continue;
      if (parsed.minPv !== null && parsed.minPv !== undefined && currentMonthPv < parsed.minPv) continue;
      if (parsed.maxPv !== null && parsed.maxPv !== undefined && currentMonthPv > parsed.maxPv) continue;
      if (parsed.targetPv !== null && parsed.targetPv !== undefined && currentMonthPv !== parsed.targetPv) continue;
      if (parsed.pureConsumers && identity.highest_pin) continue;
      if (wantsTerminated && node.status !== 0) continue;

      rows.push({
        buyer_id: node.buyer_id,
        parent_id: node.parent_id,
        depth: node.depth,
        name: identity.name || node.name,
        mobile_no: pickMobile(identity) || null,
        district: identity.district || null,
        state: identity.state || null,
        display_wall: identity.highest_pin || (node.status === 0 ? 'TERMINATED' : 'ASSOCIATE BUYER'),
        leg_letter: node.leg_letter,
        leg_type: node.leg_type,
        current_month_pv: currentMonthPv,
        repurchase_amt: node.repurchase_amt,
        monthly_pv: monthlyPv,
        monthly_purchase_amt: monthlyPurchaseAmt,
        total_pv: totalPv,
        status: node.status,
        kyc_status: node.kyc_status || identity.kyc_status || null,
        custom_photo_url: identity.custom_photo_url || null,
        profile_photo_url: identity.profile_photo_url || null,
        photo_url: pickPhoto(identity)
      });
    }

    rows.sort((a, b) => b.current_month_pv - a.current_month_pv || b.repurchase_amt - a.repurchase_amt);

    return res.status(200).json({
      success: true,
      rootBuyerId: rootId,
      months: monthLabels,
      monthKeys,
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
      select('SELECT * FROM rcm_downline_nodes WHERE buyer_id = :memberId LIMIT 1', { memberId })
    ]);
    const identity = identityMap.get(memberId) || null;
    const raw = nodeRows[0] || null;
    const node = raw ? normalizeNode(raw, 0) : null;

    if (!identity && !node) {
      return res.status(404).json({ success: false, message: 'Member profile not found.' });
    }

    const name = identity?.name || node?.name || `Associate #${memberId}`;
    const terminated = node && node.status === 0;

    return res.status(200).json({
      success: true,
      data: {
        buyer_id: memberId,
        name,
        applicant_name: name,
        join_date: identity?.join_date || null,
        kyc_status: node?.kyc_status || identity?.kyc_status || (terminated ? 'Terminated' : null),
        curr_pin: identity?.curr_pin || null,
        max_pin: identity?.max_pin || null,
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
        self_pv: node ? node.self_pv : 0,
        current_pv: node ? node.self_pv : 0,
        repurchase_amt: node ? node.repurchase_amt : 0,
        total_group_pv: node ? node.total_group_pv : 0,
        children_count: node ? node.children_count : 0,
        status: node ? node.status : 1,
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

    const tree = await loadTree(rootId);
    const { members } = analyzeTree(tree, rootId);
    const ids = [rootId, ...members.map((m) => m.buyer_id)];
    const identityMap = await loadIdentities(ids);
    const pvMap = new Map(members.map((m) => [m.buyer_id, m.pv]));
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

    const tree = await loadTree(rootId);
    const { members } = analyzeTree(tree, rootId);
    const inactive = members
      .filter((m) => m.kind === 'inactive')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const identityMap = await loadIdentities(inactive.map((m) => m.buyer_id));

    const data = inactive.map((node) => {
      const identity = identityMap.get(node.buyer_id) || {};
      return {
        buyer_id: node.buyer_id,
        parent_id: node.parent_id,
        depth: node.depth,
        leg_type: node.leg_type,
        status: node.status,
        name: identity.name || node.name,
        self_pv: node.self_pv,
        current_pv: node.self_pv,
        repurchase_amt: node.repurchase_amt,
        mobile_no: pickMobile(identity) || null,
        district: identity.district || null,
        state: identity.state || null,
        post_village: identity.post_village || null,
        curr_pin: identity.curr_pin || null,
        max_pin: identity.max_pin || null,
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
    const rows = await fetchTurnoverRows(rootId, 12);
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
    if (!photoUrl.startsWith('http://') && !photoUrl.startsWith('https://') && !photoUrl.startsWith('/uploads/')) {
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

exports.getOverview = exports.getLifelinesOverview;
exports.getTreeChildren = exports.getLifelinesChildren;
exports.getMemberDetail = exports.getMemberFullProfile;
exports.assistantQuery = exports.getAssistantQuery;