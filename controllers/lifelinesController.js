'use strict';

const axios = require('axios');
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
const activeView = require('../services/rcmActiveView');

const ECOM_BASE = 'https://ecomapi.rcmworld.com/api';

// ---------------------------------------------------------------------------
// Resilient Scraper & Session Adapters
// ---------------------------------------------------------------------------
async function persistSessionSafely(buyerId, session) {
  try {
    if (typeof saveSession === 'function') return await saveSession(buyerId, session);
    if (typeof rcmGroupScraper.saveSession === 'function') return await rcmGroupScraper.saveSession(buyerId, session);
    if (session && typeof session.saveSession === 'function') return await session.saveSession();
  } catch (err) {
    console.warn('[SESSION PERSIST NOTICE]:', err.message);
  }
  return null;
}

async function retrieveSessionSafely(buyerId) {
  if (typeof getSession === 'function') return await getSession(buyerId);
  if (typeof rcmGroupScraper.getSession === 'function') return await rcmGroupScraper.getSession(buyerId);
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
        join_date: overview.joinDate,
        proposer_id: overview.proposerId,
        proposer_name: overview.proposerName,
        sponsor_id: overview.sponsorId,
        sponsor_name: overview.sponsorName
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

const activeBackgroundCrawls = new Set();

function triggerBackgroundDeltaCrawl(session, buyerId, macroInfo = {}) {
  const crawlKey = String(buyerId);
  if (activeBackgroundCrawls.has(crawlKey)) return false;
  activeBackgroundCrawls.add(crawlKey);
  setImmediate(async () => {
    try {
      await scrapeGroupSafe(session, buyerId, macroInfo);
    } catch (err) {
      console.error('[BACKGROUND CRAWL ERROR]:', err.message);
      emitProgress('LIFELINES_SYNC_PROGRESS', { buyerId, status: 'error', isComplete: true, message: 'Tree sync failed.' });
    } finally {
      activeBackgroundCrawls.delete(crawlKey);
      invalidateTree(buyerId);
    }
  });
  return true;
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
      knownMacroPv: firstDefined(macroInfo?.totalPv, macroInfo?.total_pv, 0),
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear(),
      forceFullCrawl: null,
      onComplete: ({ phase, count, isComplete, error }) => {
        invalidateTree(buyerId);
        if (typeof emitProgress === 'function' && isComplete) {
          emitProgress('LIFELINES_SYNC_PROGRESS', {
            buyerId,
            status: error ? 'error' : 'completed',
            percent: 100,
            count,
            phase,
            isComplete: true,
            message: error ? 'Tree sync interrupted.' : 'Lifelines tree and new joinings updated.'
          });
        }
      }
    });
  }
  return undefined;
}

function getCrawlStatusSafe(rootId) {
  if (typeof rcmGroupScraper.getCrawlStatus === 'function') return rcmGroupScraper.getCrawlStatus(rootId);
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
function sendSafe(res, statusCode, payload) {
  if (!res || res.headersSent || res.writableEnded) return undefined;
  return res.status(statusCode).json(payload);
}

function setNoStore(res) {
  if (res && !res.headersSent) res.set('Cache-Control', 'no-store');
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const round2 = (v) => Math.round(safeNumber(v) * 100) / 100;

function firstPositive(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

const normalizeValue = (v) => (v === undefined || v === null || v === '' ? null : v);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const legLabel = (i) => (i < 26 ? String.fromCharCode(65 + i) : `L${i + 1}`);

function parseLegLetter(value) {
  const m = String(value || '').match(/^\s*(?:leg\s*)?([A-Za-z])\s*$/i);
  return m ? m[1].toUpperCase() : null;
}

const monthKeyOf = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabelOf = (d) => d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

function parseDateLoose(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const str = String(value).trim();
  if (!str) return null;

  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const fallback = new Date(str);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

const formatDateOnly = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Resolves official join_date first; falls back to discovered_at when is_baseline === 0
function resolveEffectiveJoinDate(identity = {}, node = null) {
  const official = parseDateLoose(firstDefined(identity?.join_date, node?.join_date));
  if (official) return { date: official, source: 'official' };
  if (node && Number(node.is_baseline ?? 1) === 0 && node.discovered_at) {
    const discovered = parseDateLoose(node.discovered_at);
    if (discovered) return { date: discovered, source: 'discovered' };
  }
  return null;
}

function getCurrentAndClosedMonthKeys() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { currentKey: monthKeyOf(now), closedKey: monthKeyOf(prev) };
}

function resolveRoot(req, res, suppliedRoot) {
  const tokenRoot = req.lifelinesRoot ? Number(req.lifelinesRoot) : null;
  const supplied = safeNumber(suppliedRoot, 0);
  if (tokenRoot) {
    if (supplied && supplied !== tokenRoot) {
      sendSafe(res, 403, { success: false, message: 'You can only access your own tree.' });
      return null;
    }
    return tokenRoot;
  }
  if (!supplied) {
    sendSafe(res, 400, { success: false, message: 'buyerId is required.' });
    return null;
  }
  return supplied;
}

const select = (sql, replacements = {}) =>
  sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

// ---------------------------------------------------------------------------
// Identity loader & on-demand live portal enrichment
// ---------------------------------------------------------------------------
const IDENTITY_WANTED = [
  'buyer_id', 'name', 'custom_photo_url', 'profile_photo_url', 'photo_url',
  'highest_pin', 'pin', 'curr_pin', 'max_pin',
  'kyc_status', 'join_date', 'mobile_no', 'mobile', 'state', 'district', 'tehsil', 'city',
  'post_village', 'pincode', 'address', 'sponsor_id', 'sponsor_name', 'proposer_id', 'proposer_name'
];

async function loadIdentities(ids) {
  const map = new Map();
  if (!ids || ids.length === 0 || !RcmIdentity || !RcmIdentity.rawAttributes) return map;
  const cleanIds = [...new Set(ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
  if (cleanIds.length === 0) return map;

  const attributes = IDENTITY_WANTED.filter((a) => RcmIdentity.rawAttributes[a]);
  const parts = chunk(cleanIds, 2000);
  for (let i = 0; i < parts.length; i += 4) {
    const batch = parts.slice(i, i + 4);
    const results = await Promise.all(
      batch.map((part) => RcmIdentity.findAll({ where: { buyer_id: part }, attributes, raw: true }).catch(() => []))
    );
    for (const rows of results) {
      rows.forEach((r) => map.set(Number(r.buyer_id), r));
    }
  }
  return map;
}

const pickPhoto = (identity = {}) =>
  identity.custom_photo_url || identity.profile_photo_url || identity.photo_url || null;
const pickMobile = (identity = {}) => identity.mobile_no || identity.mobile || '';
const pickPin = (identity = {}) =>
  identity.max_pin || identity.highest_pin || identity.curr_pin || identity.pin || null;

function pickFieldFromSources(sources, keys) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) {
      const v = src[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}

const memberEnrichCooldown = new Map();
const ENRICH_COOLDOWN_MS = 10 * 60 * 1000;

async function fetchPortalJson(session, url, timeoutMs = 3000) {
  const authHeader =
    session?.client?.defaults?.headers?.common?.Authorization ||
    (session?.token ? `Bearer ${session.token}` : '');
  const cookieHeader = session?.client?.defaults?.headers?.common?.Cookie || '';

  const headers = {
    Origin: 'https://www.rcmworld.com',
    Referer: 'https://www.rcmworld.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Resource: 'web',
    resource: 'web',
    'x-user-type': 'ab',
    Accept: 'application/json, text/plain, */*'
  };
  if (authHeader) headers.Authorization = authHeader;
  if (cookieHeader) headers.Cookie = cookieHeader;

  const client = session?.client || axios;
  const res = await client.get(url, { headers, timeout: timeoutMs, validateStatus: () => true });
  if (res.status !== 200 || !res.data) return null;
  const d = res.data.data;
  return Array.isArray(d) ? d[0] : (d && typeof d === 'object' ? d : null);
}

async function enrichMemberIdentityFromPortal(rootId, memberId, existing = {}) {
  const needsEnrich =
    !existing?.proposer_id ||
    !existing?.proposer_name ||
    !existing?.sponsor_name ||
    !existing?.join_date ||
    !pickMobile(existing) ||
    !existing?.district;

  if (!needsEnrich) return null;

  const ck = `${rootId}:${memberId}`;
  const lastAt = memberEnrichCooldown.get(ck);
  if (lastAt && Date.now() - lastAt < ENRICH_COOLDOWN_MS) return null;

  const session = await retrieveSessionSafely(rootId);
  if (!session) return null;

  memberEnrichCooldown.set(ck, Date.now());
  if (memberEnrichCooldown.size > 5000) memberEnrichCooldown.clear();

  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();

  try {
    const [profileData, infoData] = await Promise.race([
      Promise.all([
        fetchPortalJson(session, `${ECOM_BASE}/user/business-info/your-purchase-volume/profile?distno=${memberId}&month=${m}&year=${y}`, 3000).catch(() => null),
        fetchPortalJson(session, `${ECOM_BASE}/user/profile/get-distributor-info?dist_no=${memberId}`, 3000).catch(() => null)
      ]),
      new Promise((resolve) => setTimeout(() => resolve([null, null]), 3400))
    ]);

    const sources = [profileData, infoData].filter(Boolean);
    if (sources.length === 0) return null;

    const parsedJoin = parseDateLoose(pickFieldFromSources(sources, ['join_date', 'doj', 'joining_date', 'reg_date']));
    const enriched = {
      name: pickFieldFromSources(sources, ['dist_name', 'name', 'title']),
      proposer_id: pickFieldFromSources(sources, ['proposer_id', 'proposer_no', 'proposer_ab_no', 'proposer_distno', 'proposer']),
      proposer_name: pickFieldFromSources(sources, ['proposer_name', 'proposer_dist_name', 'proposer_ab_name']),
      sponsor_id: pickFieldFromSources(sources, ['sponsor_id', 'sponsor_no', 'sponsor_ab_no', 'sponsor_distno', 'sponsor', 'upline_id', 'upline_no']),
      sponsor_name: pickFieldFromSources(sources, ['sponsor_name', 'sponsor_dist_name', 'sponsor_ab_name', 'upline_name']),
      mobile_no: pickFieldFromSources(sources, ['mobile_no', 'mobile', 'mob_no', 'phone', 'contact_no']),
      district: pickFieldFromSources(sources, ['district', 'district_name', 'city']),
      state: pickFieldFromSources(sources, ['state', 'state_name']),
      tehsil: pickFieldFromSources(sources, ['tehsil', 'taluka']),
      post_village: pickFieldFromSources(sources, ['post_village', 'village']),
      pincode: pickFieldFromSources(sources, ['pincode', 'pin_code']),
      address: pickFieldFromSources(sources, ['address', 'address_line']),
      curr_pin: pickFieldFromSources(sources, ['curr_pin', 'current_pin', 'pin_level']),
      max_pin: pickFieldFromSources(sources, ['max_pin', 'highest_pin']),
      kyc_status: pickFieldFromSources(sources, ['kyc_status']),
      photo_url: pickFieldFromSources(sources, ['user_image', 'photo_url', 'profile_photo_url']),
      join_date: parsedJoin ? formatDateOnly(parsedJoin) : null
    };

    if (RcmIdentity && RcmIdentity.rawAttributes) {
      const attrs = RcmIdentity.rawAttributes;
      const upsertPayload = { buyer_id: Number(memberId) };
      for (const [k, v] of Object.entries(enriched)) {
        if (!v) continue;
        if (attrs[k]) upsertPayload[k] = k === 'join_date' ? parsedJoin : v;
      }
      if (enriched.mobile_no && attrs.mobile && !upsertPayload.mobile) upsertPayload.mobile = enriched.mobile_no;
      if (enriched.max_pin && attrs.highest_pin && !upsertPayload.highest_pin) upsertPayload.highest_pin = enriched.max_pin;
      if (enriched.photo_url && attrs.profile_photo_url && !upsertPayload.profile_photo_url) upsertPayload.profile_photo_url = enriched.photo_url;

      if (Object.keys(upsertPayload).length > 1) {
        await RcmIdentity.upsert(upsertPayload).catch((err) => console.warn('[ENRICH UPSERT WARN]:', err.message));
      }
    }

    return enriched;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TREE ENGINE: Shared In-Memory Graph + Instant Multi-User Subtree Slicing
// ---------------------------------------------------------------------------
const NODE_COLUMN_CANDIDATES = [
  'buyer_id', 'parent_id', 'name', 'status', 'kyc_status', 'leg_type', 'level',
  'current_pv', 'self_pv', 'repurchase_amt', 'purchase_amt', 'total_group_pv', 'children_count',
  'join_date', 'sponsor_id', 'sponsor_name', 'proposer_id', 'proposer_name',
  'is_baseline', 'discovered_at'
];
const GRAPH_TTL_MS = 60 * 1000;
const GRAPH_MIN_RELOAD_MS = 5 * 1000;
const TREE_TTL_MS = 30 * 1000;
const MAX_CACHED_TREES = 30;

let nodeDescPromise = null;
function getNodeDesc() {
  if (!nodeDescPromise) {
    nodeDescPromise = sequelize.getQueryInterface().describeTable('rcm_downline_nodes')
      .then((desc) => {
        if (!desc.buyer_id || !desc.parent_id) {
          throw new Error('rcm_downline_nodes must have buyer_id and parent_id columns.');
        }
        return desc;
      })
      .catch((err) => {
        nodeDescPromise = null;
        throw err;
      });
  }
  return nodeDescPromise;
}

async function getNodeColumns() {
  const desc = await getNodeDesc();
  return NODE_COLUMN_CANDIDATES.filter((c) => desc[c]);
}

const columnSql = (cols) => cols.map((c) => `\`${c}\``).join(', ');

function normalizeNode(row, depth) {
  const selfPv = safeNumber(firstDefined(row.self_pv, row.current_pv));
  return {
    buyer_id: Number(row.buyer_id),
    parent_id: row.parent_id === null || row.parent_id === undefined || row.parent_id === '' ? null : Number(row.parent_id),
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
    join_date: row.join_date || null,
    sponsor_id: row.sponsor_id || null,
    sponsor_name: row.sponsor_name || null,
    proposer_id: row.proposer_id || null,
    proposer_name: row.proposer_name || null,
    is_baseline: row.is_baseline === undefined || row.is_baseline === null ? 1 : Number(row.is_baseline),
    discovered_at: row.discovered_at || null,
    depth
  };
}

let globalGraphEntry = null;

function loadGlobalGraph({ fresh = false } = {}) {
  const now = Date.now();
  const age = globalGraphEntry ? now - globalGraphEntry.at : Infinity;
  if (globalGraphEntry && (fresh ? age < GRAPH_MIN_RELOAD_MS : age < GRAPH_TTL_MS)) {
    return globalGraphEntry.promise;
  }

  const promise = (async () => {
    const cols = columnSql(await getNodeColumns());
    const rows = await select(`SELECT ${cols} FROM rcm_downline_nodes`);
    const nodeMap = new Map();
    const childrenMap = new Map();

    for (const row of rows) {
      const key = String(row.buyer_id);
      const node = normalizeNode(row, 0);
      nodeMap.set(key, node);
      if (node.parent_id !== null && node.parent_id !== node.buyer_id) {
        const parentKey = String(node.parent_id);
        let list = childrenMap.get(parentKey);
        if (!list) {
          list = [];
          childrenMap.set(parentKey, list);
        }
        list.push(node);
      }
    }

    return { nodeMap, childrenMap, builtAt: Date.now() };
  })().catch((err) => {
    if (globalGraphEntry && globalGraphEntry.promise === promise) globalGraphEntry = null;
    throw err;
  });

  globalGraphEntry = { at: now, promise };
  return promise;
}

function sliceSubtreeFromGraph(graph, rootId) {
  const rootKey = String(rootId);
  if (!graph.nodeMap.has(rootKey)) {
    return { nodeMap: new Map(), childrenMap: new Map(), builtAt: graph.builtAt, truncated: false };
  }

  const subtreeNodeMap = new Map();
  const subtreeChildrenMap = new Map();
  const queue = [{ id: rootKey, depth: 0 }];
  const visited = new Set();

  for (let qi = 0; qi < queue.length; qi += 1) {
    const { id, depth } = queue[qi];
    if (visited.has(id)) continue;
    visited.add(id);

    const src = graph.nodeMap.get(id);
    if (!src) continue;
    subtreeNodeMap.set(id, { ...src, depth });

    const kids = graph.childrenMap.get(id);
    if (kids && kids.length > 0) {
      subtreeChildrenMap.set(id, kids);
      for (const kid of kids) {
        const kidId = String(kid.buyer_id);
        if (!visited.has(kidId)) queue.push({ id: kidId, depth: depth + 1 });
      }
    }
  }

  return { nodeMap: subtreeNodeMap, childrenMap: subtreeChildrenMap, builtAt: graph.builtAt, truncated: false };
}

const treeCache = new Map();

function invalidateTree(rootId) {
  if (rootId !== undefined && rootId !== null) treeCache.delete(String(rootId));
  else treeCache.clear();
  if (globalGraphEntry && Date.now() - globalGraphEntry.at >= GRAPH_MIN_RELOAD_MS) {
    globalGraphEntry = null;
  }
}

function loadTree(rootId, { fresh = false } = {}) {
  const key = String(rootId);
  const hit = treeCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (fresh ? age < GRAPH_MIN_RELOAD_MS : age < TREE_TTL_MS)) return hit.promise;

  if (treeCache.size >= MAX_CACHED_TREES) {
    for (const [k, v] of treeCache) {
      if (Date.now() - v.at >= TREE_TTL_MS) treeCache.delete(k);
    }
    if (treeCache.size >= MAX_CACHED_TREES) treeCache.delete(treeCache.keys().next().value);
  }

  const promise = loadGlobalGraph({ fresh })
    .then((graph) => sliceSubtreeFromGraph(graph, rootId))
    .catch((err) => {
      treeCache.delete(key);
      throw err;
    });

  treeCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function buildAncestorPath(rootId, targetId) {
  const tree = await loadTree(rootId);
  const chain = [];
  const visited = new Set();
  let curr = String(targetId);

  for (let hop = 0; hop < 150 && curr; hop += 1) {
    if (visited.has(curr)) break;
    visited.add(curr);
    const node = tree.nodeMap.get(curr);
    if (!node) break;
    chain.push(node);
    if (Number(node.buyer_id) === Number(rootId) || !node.parent_id) break;
    curr = String(node.parent_id);
  }

  const identities = await loadIdentities(chain.map((n) => n.buyer_id));
  const path = [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const n = chain[i];
    const idRow = identities.get(n.buyer_id) || {};
    path.push({
      buyer_id: n.buyer_id,
      parent_id: n.parent_id,
      name: idRow.name || n.name || `Associate #${n.buyer_id}`,
      photo_url: pickPhoto(idRow),
      highest_pin: pickPin(idRow) || 'ASSOCIATE BUYER',
      status: n.status,
      self_pv: n.self_pv,
      repurchase_amt: n.repurchase_amt,
      total_group_pv: n.total_group_pv
    });
  }
  return path;
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

function assignLegLetters(heads, { useStoredLeg = true } = {}) {
  const sortedById = heads.slice().sort((a, b) => a.buyer_id - b.buyer_id);
  const used = new Set();
  const letterOf = new Map();

  if (useStoredLeg) {
    for (const head of sortedById) {
      const letter = parseLegLetter(head.leg_type);
      if (letter && !used.has(letter)) {
        used.add(letter);
        letterOf.set(head.buyer_id, letter);
      }
    }
  }

  let cursor = 0;
  for (const head of sortedById) {
    if (letterOf.has(head.buyer_id)) continue;
    while (used.has(legLabel(cursor))) cursor += 1;
    const letter = legLabel(cursor);
    used.add(letter);
    letterOf.set(head.buyer_id, letter);
  }

  return sortedById
    .map((head) => ({ head, letter: letterOf.get(head.buyer_id) }))
    .sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : a.head.buyer_id - b.head.buyer_id));
}

function analyzeTree(tree, rootId) {
  const rootKey = String(rootId);
  const rootNode = tree.nodeMap.get(rootKey) || null;
  const heads = tree.childrenMap.get(rootKey) || [];
  const orderedHeads = assignLegLetters(heads, { useStoredLeg: true });

  const totals = { members: 0, active: 0, inactive: 0, terminated: 0, pv: 0, repurchase: 0 };
  const members = [];
  const visited = new Set([rootKey]);

  const legs = orderedHeads.map(({ head, letter }) => {
    const leg = { head, letter, members: 0, active: 0, inactive: 0, terminated: 0, pv: 0, repurchase: 0 };
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
// Direct SQL for fresh single-parent reads (with accurate children_count)
// ---------------------------------------------------------------------------
async function fetchChildrenRows(parentId) {
  const cols = columnSql(await getNodeColumns());
  const rows = await select(`SELECT ${cols} FROM rcm_downline_nodes WHERE parent_id = :parentId`, {
    parentId: String(parentId)
  });
  const nodes = rows.map((r) => normalizeNode(r, 0));
  nodes.sort((a, b) => b.total_group_pv - a.total_group_pv || b.pv - a.pv || a.buyer_id - b.buyer_id);

  const childCounts = new Map();
  const ids = nodes.map((n) => n.buyer_id);
  for (const part of chunk(ids, 500)) {
    const kidRows = await select(
      'SELECT parent_id, COUNT(*) AS cnt FROM rcm_downline_nodes WHERE parent_id IN (:ids) GROUP BY parent_id',
      { ids: part.map(String) }
    );
    kidRows.forEach((r) => childCounts.set(Number(r.parent_id), Number(r.cnt) || 0));
  }

  return nodes.map((n) => {
    const actualCount = Math.max(childCounts.get(n.buyer_id) || 0, n.children_count || 0);
    return { ...n, children_count: actualCount, has_children: actualCount > 0 };
  });
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
    join_date: identity.join_date || node.join_date || null,
    mobile_no: pickMobile(identity) || null,
    district: identity.district || null,
    state: identity.state || null,
    leg_type: node.leg_type || null,
    sponsor_id: firstDefined(identity.sponsor_id, node.sponsor_id, node.parent_id) || null,
    sponsor_name: firstDefined(identity.sponsor_name, node.sponsor_name) || null,
    proposer_id: firstDefined(identity.proposer_id, node.proposer_id) || null,
    proposer_name: firstDefined(identity.proposer_name, node.proposer_name) || null,
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
  const order = [];
  if (orderCol) order.push([orderCol, 'DESC']);
  if (attrs.updated_at) order.push(['updated_at', 'DESC']);
  if (attrs.id) order.push(['id', 'DESC']);

  const rawRows = await RcmMonthlyTurnoverHistory.findAll({
    where: { buyer_id: buyerId },
    ...(order.length ? { order } : {}),
    limit: Math.max(limit * 4, 48),
    raw: true
  });

  const seen = new Set();
  const deduped = [];
  for (const row of rawRows) {
    const key = rowMonthKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// POST /sync
// ---------------------------------------------------------------------------
exports.syncLifelines = async (req, res) => {
  try {
    setNoStore(res);
    const rawId = req.body?.buyerId || req.body?.buyer_id || req.body?.dist_no || req.body?.distNo || req.body?.rcmId || req.body?.id;
    const password = req.body?.password || req.body?.rcmPassword || req.body?.pass;
    const buyerId = safeNumber(rawId, 0);

    if (!/^\d{6,10}$/.test(String(buyerId)) || !password) {
      return sendSafe(res, 400, { success: false, message: 'Valid buyerId and password are required.' });
    }

    const idKey = `sync:id:${buyerId}`;
    if (!allowAttempt(idKey, 8, 60 * 1000)) {
      return sendSafe(res, 429, { success: false, message: 'Too many login attempts for this ID. Please wait a minute and retry.' });
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
      return sendSafe(res, isCredentialError ? 401 : 502, {
        success: false,
        message: isCredentialError ? 'Invalid RCM ID or password.' : 'RCM portal is not reachable right now. Please retry.'
      });
    }

    clearAttempts(idKey);
    await persistSessionSafely(buyerId, session);
    const token = issueToken(buyerId);

    let macroInfo = {};
    try {
      macroInfo = (await fetchMacroSafe(session, buyerId)) || {};
    } catch (macroErr) {
      console.warn('[MACRO FETCH FALLBACK]:', macroErr.message);
    }

    invalidateTree(buyerId);

    sendSafe(res, 200, {
      success: true,
      message: 'Instant macro overview unlocked.',
      token,
      lifelinesToken: token,
      buyerId,
      identity: macroInfo?.identity || { buyer_id: buyerId },
      macroData: {
        buyer_id: buyerId,
        name: macroInfo.associateName || macroInfo.identity?.name || '',
        curr_pin: macroInfo.currPin || macroInfo.identity?.curr_pin || '',
        max_pin: macroInfo.maxPin || macroInfo.identity?.highest_pin || '',
        photo_url: macroInfo.photoUrl || macroInfo.identity?.photo_url || '',
        kyc_status: macroInfo.kycStatus || macroInfo.identity?.kyc_status || '',
        join_date: macroInfo.joinDate || macroInfo.identity?.join_date || '',
        total_pv: firstDefined(macroInfo.totalPv, macroInfo.total_pv, 0),
        self_pv: firstDefined(macroInfo.selfPv, macroInfo.self_pv, 0),
        closed_month_pv: macroInfo.closedMonthPv ?? null,
        closed_self_pv: macroInfo.closedSelfPv ?? null,
        directLegs: macroInfo.directLegs || macroInfo.legs || []
      }
    });

    triggerBackgroundDeltaCrawl(session, buyerId, macroInfo);
    return undefined;
  } catch (error) {
    console.error('Error in syncLifelines:', error.message);
    return sendSafe(res, 500, { success: false, message: 'Lifelines sync failed.' });
  }
};

// ---------------------------------------------------------------------------
// GET /live-check/:buyerId
// ---------------------------------------------------------------------------
exports.liveCheckLifelines = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const monthKey = `${year}${String(month).padStart(2, '0')}`;
    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;

    const session = await retrieveSessionSafely(rootId);
    if (!session) {
      return sendSafe(res, 200, {
        success: true, hasSession: false, sessionExpired: true, pvChanged: false, deltaTriggered: false
      });
    }

    if (typeof session.isAuthenticated === 'function') {
      const authed = await Promise.race([
        session.isAuthenticated(),
        new Promise((resolve) => setTimeout(() => resolve(true), 2500))
      ]);
      if (!authed) {
        removeSessionSafely(rootId);
        return sendSafe(res, 200, {
          success: true, hasSession: false, sessionExpired: true, pvChanged: false, deltaTriggered: false
        });
      }
    }

    let pvSnap = { ok: false };
    if (typeof rcmGroupScraper.fetchPvOnlyFull === 'function') {
      pvSnap = await Promise.race([
        rcmGroupScraper.fetchPvOnlyFull(session, rootId, month, year),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 4500))
      ]);
    }

    if (!pvSnap.ok) {
      return sendSafe(res, 200, {
        success: true, hasSession: true, sessionExpired: false, liveCheckSkipped: true, pvChanged: false, deltaTriggered: false
      });
    }

    const livePv = round2(pvSnap.groupPv || 0);
    const liveSelfPv = round2(pvSnap.selfPv || 0);

    let prevMacroPv = 0;
    let prevProcessedPv = 0;
    let prevState = '';
    if (sequelize) {
      const stRows = await select(
        'SELECT state, macro_pv, processed_pv FROM rcm_sync_state WHERE owner_id = :owner AND month_key = :monthKey LIMIT 1',
        { owner: Number(rootId), monthKey }
      ).catch(() => []);
      if (stRows[0]) {
        prevState = String(stRows[0].state || '');
        prevMacroPv = round2(stRows[0].macro_pv || 0);
        prevProcessedPv = round2(stRows[0].processed_pv || 0);
      }
    }

    const pvChanged = livePv > 0 && Math.abs(livePv - prevMacroPv) > 0.05;
    const hasGap = livePv > 0 && (prevState !== 'VERIFIED' || Math.abs(livePv - prevProcessedPv) > 0.05);

    if (livePv > 0 && sequelize) {
      await sequelize.query(
        `UPDATE rcm_sync_state
            SET macro_pv = :macroPv,
                residual_pv = GREATEST(0, ROUND(:macroPv - processed_pv, 2)),
                state = IF(ABS(:macroPv - processed_pv) > 0.05, 'BOUNDED', state),
                updated_at = :now
          WHERE owner_id = :owner AND month_key = :monthKey`,
        { replacements: { macroPv: livePv, now: new Date(), owner: Number(rootId), monthKey } }
      ).catch(() => {});

      if (RcmMonthlyTurnoverHistory) {
        const attrs = RcmMonthlyTurnoverHistory.rawAttributes || {};
        const monthCol = attrs.year_month ? 'year_month' : attrs.month_key ? 'month_key' : null;
        if (monthCol) {
          const monthVal = monthCol === 'year_month' ? yearMonth : monthKey;
          const hist = await RcmMonthlyTurnoverHistory.findOne({
            where: { buyer_id: Number(rootId), [monthCol]: monthVal }
          }).catch(() => null);
          if (hist) {
            await hist.update({
              total_pv: livePv,
              ...(liveSelfPv > 0 ? { self_pv: liveSelfPv } : {}),
              updated_at: new Date()
            }).catch(() => {});
          }
        }
      }
    }

    let deltaTriggered = false;
    if (pvChanged || hasGap) {
      invalidateTree(rootId);
      deltaTriggered = triggerBackgroundDeltaCrawl(session, rootId, { totalPv: livePv, selfPv: liveSelfPv });
    }

    return sendSafe(res, 200, {
      success: true,
      hasSession: true,
      sessionExpired: false,
      totalPv: livePv,
      selfPv: liveSelfPv,
      pvChanged,
      hasGap,
      deltaTriggered,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.warn('Error in liveCheckLifelines:', error.message);
    return sendSafe(res, 200, {
      success: true, hasSession: true, sessionExpired: false, pvChanged: false, deltaTriggered: false
    });
  }
};

exports.logoutLifelines = async (req, res) => {
  setNoStore(res);
  if (req.lifelinesRoot) {
    removeSessionSafely(req.lifelinesRoot);
    treeCache.delete(String(req.lifelinesRoot));
  }
  revokeToken(req.lifelinesToken);
  return sendSafe(res, 200, { success: true });
};

exports.getSyncStatus = async (req, res) => {
  setNoStore(res);
  const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
  if (!rootId) return undefined;
  return sendSafe(res, 200, {
    success: true,
    data: {
      crawl: getCrawlStatusSafe(rootId),
      hasSession: Boolean(await retrieveSessionSafely(rootId))
    }
  });
};

// ---------------------------------------------------------------------------
// GET /overview/:buyerId
// ---------------------------------------------------------------------------
exports.getLifelinesOverview = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const { currentKey, closedKey } = getCurrentAndClosedMonthKeys();
    const historyMonths = Math.min(Math.max(Math.floor(safeNumber(req.query.months, 3)), 1), 12);

    const [identityMap, tree, historyRows] = await Promise.all([
      loadIdentities([rootId]),
      loadTree(rootId),
      fetchTurnoverRows(rootId, Math.max(historyMonths, 12)).catch(() => [])
    ]);

    if (res.headersSent || res.writableEnded) return undefined;

    const identity = identityMap.get(rootId) || {};
    const { rootNode, legs, totals } = analyzeTree(tree, rootId);

    const turnoverCurrent = historyRows.find((h) => rowMonthKey(h) === currentKey) || null;
    const turnoverClosed = historyRows.find((h) => rowMonthKey(h) === closedKey) || null;

    let liveSummary = { exists: false };
    try {
      if (activeView && typeof activeView.getSummary === 'function') {
        liveSummary = await activeView.getSummary(rootId, currentKey);
      }
    } catch (err) {
      console.warn('[ACTIVE VIEW LOAD NOTICE]:', err.message);
    }

    const selfRepurchaseAmt = rootNode ? rootNode.repurchase_amt : 0;
    const selfPv = firstPositive(turnoverCurrent?.self_pv, rootNode?.self_pv);
    const totalPv = firstPositive(
      liveSummary.exists ? liveSummary.macroPv : 0,
      turnoverCurrent?.total_pv,
      rootNode?.total_group_pv,
      totals.pv + selfPv
    );

    const liveVerified = Boolean(liveSummary.exists && liveSummary.state === 'VERIFIED' && liveSummary.amtComplete);
    const totalTeamRepurchaseAmt = liveSummary.exists && liveSummary.totals && liveSummary.totals.amt > 0
      ? round2(liveSummary.totals.amt)
      : round2(totals.repurchase + selfRepurchaseAmt);

    const rootIsActivePurchaser = Boolean(
      rootNode && Number(rootNode.status) !== 0 && (rootNode.pv > 0 || rootNode.repurchase_amt > 0 || selfPv > 0)
    );
    const treeActivePurchasers = totals.active + (rootIsActivePurchaser ? 1 : 0);

    const liveCounts = liveSummary.exists && liveSummary.counts ? liveSummary.counts : null;
    const effectiveTotalTeam = liveCounts && liveCounts.totalMembers > 0
      ? Math.max(liveCounts.totalMembers, totals.members)
      : (totals.members || 0);
    const effectiveTerminated = liveCounts && liveCounts.totalMembers > 0
      ? liveCounts.terminatedMembers
      : (totals.terminated || 0);
    const effectiveActive = liveCounts && (liveVerified || liveCounts.activeBuyers > 0)
      ? liveCounts.activeBuyers
      : treeActivePurchasers;
    const effectiveInactive = effectiveTotalTeam > 0
      ? Math.max(0, effectiveTotalTeam - effectiveTerminated - effectiveActive)
      : (totals.inactive || 0);

    const legIdentities = await loadIdentities(legs.map((l) => l.head.buyer_id));

    const directLegs = legs.map((leg, idx) => {
      const head = leg.head;
      const legIdentity = legIdentities.get(head.buyer_id) || {};
      const turnoverLegPv = idx === 0 ? safeNumber(turnoverCurrent?.leg_a_pv) : idx === 1 ? safeNumber(turnoverCurrent?.leg_b_pv) : 0;
      const officialPv = firstPositive(head.total_group_pv, turnoverLegPv, leg.pv);
      const liveLeg = liveSummary.exists ? (liveSummary.legs || []).find((l) => l.leg === leg.letter) : null;
      const legRepurchase = liveLeg && liveLeg.amt > 0 ? round2(liveLeg.amt) : round2(leg.repurchase);
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
        highest_pin: pickPin(legIdentity),
        pv: officialPv,
        subtree_pv: officialPv,
        total_leg_subtree_pv: officialPv,
        crawled_pv: leg.pv,
        repurchase_amt: legRepurchase,
        total_leg_repurchase_amt: legRepurchase,
        subtree_repurchase_amt: legRepurchase,
        status: head.status,
        has_children: (tree.childrenMap.get(String(head.buyer_id)) || []).length > 0
      };
    });

    const monthlyHistory = [];
    const now = new Date();
    for (let i = 0; i < historyMonths; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = monthKeyOf(d);
      const hist = i === 0 ? turnoverCurrent : historyRows.find((h) => rowMonthKey(h) === key) || null;
      monthlyHistory.push({
        monthKey: key,
        monthLabel: monthLabelOf(d),
        isCurrent: i === 0,
        hasData: i === 0 || Boolean(hist),
        totalPv: i === 0 ? totalPv : (hist ? safeNumber(hist.total_pv) : null),
        selfPv: i === 0 ? selfPv : (hist ? safeNumber(hist.self_pv) : null),
        selfRepurchaseAmt: i === 0 ? round2(selfRepurchaseAmt) : (hist && hist.self_repurchase_amt !== undefined ? round2(hist.self_repurchase_amt) : null),
        legAPv: i === 0 ? (directLegs[0]?.pv ?? 0) : (hist ? safeNumber(hist.leg_a_pv) : null),
        legBPv: i === 0 ? (directLegs[1]?.pv ?? 0) : (hist ? safeNumber(hist.leg_b_pv) : null)
      });
    }

    const officialPin = pickPin(identity);
    const profilePic = pickPhoto(identity);
    const displayName = identity.name || rootNode?.name || `Associate #${rootId}`;
    const closedTotalPv = turnoverClosed ? safeNumber(turnoverClosed.total_pv) : null;
    const closedSelfPv = turnoverClosed ? safeNumber(turnoverClosed.self_pv) : null;

    return sendSafe(res, 200, {
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
        synced: Boolean(rootNode || turnoverCurrent || liveSummary.exists),
        treeTruncated: Boolean(tree.truncated),
        total_pv: totalPv,
        totalPv,
        self_pv: selfPv,
        selfPv,
        self_repurchase_amt: round2(selfRepurchaseAmt),
        selfRepurchaseAmt: round2(selfRepurchaseAmt),
        total_repurchase_amt: totalTeamRepurchaseAmt,
        total_team_repurchase_amt: totalTeamRepurchaseAmt,
        totalTeamRepurchaseAmt,
        total_network_turnover: totalTeamRepurchaseAmt,
        totalNetworkTurnover: totalTeamRepurchaseAmt,
        closed_month_pv: closedTotalPv,
        closed_self_pv: closedSelfPv,
        total_team: effectiveTotalTeam,
        active_purchasers: effectiveActive,
        inactive_members: effectiveInactive,
        terminated_members: effectiveTerminated,
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
          totalMembers: effectiveTotalTeam,
          active: effectiveActive,
          inactive: effectiveInactive,
          terminated: effectiveTerminated,
          zeroPv: effectiveInactive,
          totalPv,
          selfPv,
          totalRepurchaseAmt: totalTeamRepurchaseAmt,
          totalNetworkTurnover: totalTeamRepurchaseAmt,
          activePurchasers: effectiveActive
        },
        directLegs,
        legs: directLegs,
        monthlyHistory,
        crawl: getCrawlStatusSafe(rootId),
        live: liveSummary,
        liveState: liveSummary.exists ? liveSummary.state : 'CACHED'
      }
    });
  } catch (error) {
    console.error('Error in getLifelinesOverview:', error.message);
    return sendSafe(res, 500, { success: false, code: 'OVERVIEW_FAILED', message: 'Could not build the overview. Please retry.' });
  }
};

// ---------------------------------------------------------------------------
// GET /tree-children  |  GET /children/:buyerId
// ---------------------------------------------------------------------------
exports.getLifelinesChildren = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId || req.query.rootBuyerId);
    if (!rootId) return undefined;
    const parentId = safeNumber(req.query.parentId || req.query.parent_id, rootId) || rootId;

    if (!(await isInSubtree(rootId, parentId))) {
      return sendSafe(res, 404, { success: false, message: 'Member not found in your tree.' });
    }

    let rows = await fetchChildrenRows(parentId);
    if (rows.length === 0 && (await retrieveSessionSafely(rootId))) {
      try {
        const result = await Promise.race([
          fetchChildrenOnDemandSafe(rootId, parentId),
          new Promise((resolve) => setTimeout(() => resolve({ fetched: false, count: 0 }), 5500))
        ]);
        if (result?.fetched && result.count > 0) {
          rows = await fetchChildrenRows(parentId);
          invalidateTree(rootId);
        }
      } catch { /* ignore slow portal */ }
    }

    const identities = await loadIdentities(rows.map((n) => n.buyer_id));
    const data = rows.map((node) => formatNode(node, identities.get(node.buyer_id)));

    return sendSafe(res, 200, {
      success: true,
      data,
      meta: {
        parentId,
        crawlRunning: Boolean(getCrawlStatusSafe(rootId)?.running),
        hasSession: Boolean(await retrieveSessionSafely(rootId))
      }
    });
  } catch (error) {
    console.warn('Error in getLifelinesChildren:', error.message);
    return sendSafe(res, 200, { success: true, data: [], warning: 'Could not load children.' });
  }
};

// ---------------------------------------------------------------------------
// GET /new-joinings/:buyerId  (Uses official join_date OR is_baseline=0 + discovered_at)
// ---------------------------------------------------------------------------
const getNewJoinings = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId || req.query.rootBuyerId);
    if (!rootId) return undefined;

    const monthCount = Math.min(Math.max(Math.floor(safeNumber(req.query.months, 3)), 1), 12);
    const limit = Math.min(Math.max(Math.floor(safeNumber(req.query.limit, 1000)), 1), 5000);
    const requestedMonthKey = String(req.query.monthKey || req.query.month_key || '').trim();

    let baseDate = new Date();
    if (/^\d{6}$/.test(requestedMonthKey)) {
      const y = parseInt(requestedMonthKey.slice(0, 4), 10);
      const m = parseInt(requestedMonthKey.slice(4, 6), 10);
      if (m >= 1 && m <= 12) baseDate = new Date(y, m - 1, 1);
    }

    const windowStart = new Date(baseDate.getFullYear(), baseDate.getMonth() - (monthCount - 1), 1);
    const windowEndExclusive = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1);

    const monthLabels = [];
    const monthKeys = [];
    const labelByKey = new Map();
    for (let i = 0; i < monthCount; i += 1) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
      const key = monthKeyOf(d);
      const label = monthLabelOf(d);
      monthKeys.push(key);
      monthLabels.push(label);
      labelByKey.set(key, label);
    }

    const tree = await loadTree(rootId);
    const { members } = analyzeTree(tree, rootId);
    if (members.length === 0) {
      return sendSafe(res, 200, {
        success: true, rootBuyerId: rootId, totalNewJoinings: 0,
        months: monthLabels, monthKeys, monthCounts: {}, data: []
      });
    }

    const identityMap = await loadIdentities(members.map((m) => m.buyer_id));
    const results = [];
    const monthCounts = {};
    monthLabels.forEach((l) => { monthCounts[l] = 0; });

    const resolvePersonName = (id, explicitName) => {
      if (explicitName) return explicitName;
      if (!id) return null;
      const nId = Number(id);
      return identityMap.get(nId)?.name || tree.nodeMap.get(String(id))?.name || null;
    };

    for (const node of members) {
      const identity = identityMap.get(node.buyer_id) || {};
      const joinInfo = resolveEffectiveJoinDate(identity, node);
      if (!joinInfo) continue;

      const joined = joinInfo.date;
      if (joined < windowStart || joined >= windowEndExclusive) continue;

      const key = monthKeyOf(joined);
      const label = labelByKey.get(key) || monthLabelOf(joined);
      const sponsorId = firstDefined(identity.sponsor_id, node.sponsor_id, node.parent_id);
      const proposerId = firstDefined(identity.proposer_id, node.proposer_id);

      monthCounts[label] = (monthCounts[label] || 0) + 1;

      results.push({
        buyer_id: node.buyer_id,
        name: identity.name || node.name || `Associate #${node.buyer_id}`,
        join_date: formatDateOnly(joined),
        join_date_source: joinInfo.source,
        month_label: label,
        leg_type: node.leg_type,
        proposer_id: proposerId ? String(proposerId) : null,
        proposer_name: resolvePersonName(proposerId, firstDefined(identity.proposer_name, node.proposer_name)),
        sponsor_id: sponsorId ? String(sponsorId) : null,
        sponsor_name: resolvePersonName(sponsorId, firstDefined(identity.sponsor_name, node.sponsor_name)),
        mobile_no: pickMobile(identity) || null,
        kyc_status: node.kyc_status || identity.kyc_status || null,
        photo_url: pickPhoto(identity),
        self_pv: node.self_pv,
        current_pv: node.pv,
        repurchase_amt: node.repurchase_amt,
        status: node.status,
        _sort: joined.getTime()
      });
    }

    results.sort((a, b) => b._sort - a._sort || b.buyer_id - a.buyer_id);
    const data = results.slice(0, limit).map(({ _sort, ...rest }) => rest);

    return sendSafe(res, 200, {
      success: true, rootBuyerId: rootId, totalNewJoinings: results.length,
      months: monthLabels, monthKeys, monthCounts, data
    });
  } catch (error) {
    console.error('Error in getNewJoinings:', error.message);
    return sendSafe(res, 200, {
      success: true, totalNewJoinings: 0, months: [], data: [], warning: 'Could not load new joinings.'
    });
  }
};

// ---------------------------------------------------------------------------
// GET /assistant-query  (Fixed past-month indexing — never leaks current PV into past months)
// ---------------------------------------------------------------------------
exports.getAssistantQuery = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, req.query.buyerId || req.query.rootBuyerId);
    if (!rootId) return undefined;

    const queryString = String(req.query.query || req.query.q || 'all').trim();
    const requestedMonthKey = String(req.query.monthKey || req.query.month_key || '').trim();
    const limit = Math.min(Math.max(safeNumber(req.query.limit, 150), 1), 500);
    const monthCount = Math.min(Math.max(Math.floor(safeNumber(req.query.months, 3)), 1), 12);
    const parsed = parseQuery(queryString) || {};

    const legRaw = req.query.leg || parsed.leg || '';
    const legFilter = String(legRaw).toUpperCase().replace(/^LEG\s*/, '').trim();

    const now = new Date();
    const actualCurrentKey = monthKeyOf(now);
    let baseDate = now;
    if (/^\d{6}$/.test(requestedMonthKey)) {
      baseDate = new Date(parseInt(requestedMonthKey.slice(0, 4), 10), parseInt(requestedMonthKey.slice(4, 6), 10) - 1, 1);
    }

    const dynamicMonths = [];
    for (let i = 0; i < monthCount; i += 1) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth() - i, 1);
      const key = monthKeyOf(d);
      const isLive = key === actualCurrentKey;
      dynamicMonths.push({
        key,
        isLive,
        label: `${monthLabelOf(d)} (${isLive ? 'Current / Live' : 'Closed'})`
      });
    }
    const monthKeys = dynamicMonths.map((m) => m.key);
    const monthLabels = dynamicMonths.map((m) => m.label);
    const isSelectedCurrentMonth = dynamicMonths[0]?.isLive === true;

    const tree = await loadTree(rootId);
    if (res.headersSent || res.writableEnded) return undefined;

    const { members } = analyzeTree(tree, rootId);
    if (members.length === 0) {
      return sendSafe(res, 200, { success: true, months: monthLabels, monthKeys, count: 0, data: [] });
    }

    const wantsTerminated = queryString.toLowerCase().includes('terminated');
    const preFiltered = [];
    for (const node of members) {
      if (legFilter && node.leg_letter !== legFilter) continue;
      if (wantsTerminated && node.status !== 0) continue;
      if (isSelectedCurrentMonth) {
        if (parsed.minPv !== null && parsed.minPv !== undefined && node.pv < parsed.minPv) continue;
        if (parsed.maxPv !== null && parsed.maxPv !== undefined && node.pv > parsed.maxPv) continue;
        if (parsed.targetPv !== null && parsed.targetPv !== undefined && node.pv !== parsed.targetPv) continue;
      }
      preFiltered.push(node);
    }

    preFiltered.sort((a, b) => b.pv - a.pv || b.repurchase_amt - a.repurchase_amt || a.buyer_id - b.buyer_id);

    const candidateCap = parsed.pureConsumers || !isSelectedCurrentMonth
      ? Math.min(preFiltered.length, limit * 6)
      : Math.min(preFiltered.length, Math.max(limit * 2, 300));
    const candidates = preFiltered.slice(0, candidateCap);
    const candidateIds = candidates.map((n) => n.buyer_id);
    const snapshotMap = new Map();

    const [identityMap] = await Promise.all([
      loadIdentities(candidateIds),
      (async () => {
        for (const part of chunk(candidateIds, 1000)) {
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

    if (res.headersSent || res.writableEnded) return undefined;

    const rows = [];
    for (const node of candidates) {
      const identity = identityMap.get(node.buyer_id) || {};
      if (parsed.pureConsumers && identity.highest_pin) continue;

      const snaps = snapshotMap.get(node.buyer_id) || {};
      const monthlyPv = {};
      const monthlyPurchaseAmt = {};
      let totalPv = 0;

      dynamicMonths.forEach((m) => {
        const snap = snaps[m.key];
        const pv = m.isLive ? firstPositive(node.pv, snap?.pv) : safeNumber(snap?.pv);
        const amt = m.isLive ? firstPositive(node.repurchase_amt, snap?.purchase_amt) : safeNumber(snap?.purchase_amt);
        monthlyPv[m.label] = pv;
        monthlyPurchaseAmt[m.label] = amt;
        totalPv += pv;
      });

      const selectedMonthPv = monthlyPv[dynamicMonths[0].label] || 0;
      const selectedMonthAmt = monthlyPurchaseAmt[dynamicMonths[0].label] || 0;

      if (!isSelectedCurrentMonth) {
        if (parsed.minPv !== null && parsed.minPv !== undefined && selectedMonthPv < parsed.minPv) continue;
        if (parsed.maxPv !== null && parsed.maxPv !== undefined && selectedMonthPv > parsed.maxPv) continue;
        if (parsed.targetPv !== null && parsed.targetPv !== undefined && selectedMonthPv !== parsed.targetPv) continue;
      }

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
        current_month_pv: selectedMonthPv,
        repurchase_amt: selectedMonthAmt,
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

    return sendSafe(res, 200, {
      success: true,
      rootBuyerId: rootId,
      months: monthLabels,
      monthKeys,
      count: parsed.pureConsumers || !isSelectedCurrentMonth ? rows.length : preFiltered.length,
      data: rows.slice(0, limit)
    });
  } catch (error) {
    console.error('Error in getAssistantQuery:', error.message);
    return sendSafe(res, 200, { success: true, months: [], count: 0, data: [], warning: 'Could not build matrix.' });
  }
};

// ---------------------------------------------------------------------------
// GET /member/:buyerId  (Local legs, live enrichment, sponsor/proposer names, is_baseline new joinings)
// ---------------------------------------------------------------------------
exports.getMemberFullProfile = async (req, res) => {
  try {
    setNoStore(res);
    const memberId = safeNumber(req.params.buyerId || req.query.buyerId, 0);
    if (!memberId) return sendSafe(res, 400, { success: false, message: 'buyerId is required.' });

    const rootId = resolveRoot(req, res, req.query.rootBuyerId);
    if (!rootId) return undefined;

    if (!(await isInSubtree(rootId, memberId))) {
      return sendSafe(res, 404, { success: false, message: 'Member not found in your tree.' });
    }

    const tree = await loadTree(rootId);
    const { members } = analyzeTree(tree, rootId);
    const targetNode = tree.nodeMap.get(String(memberId)) || null;
    const memberMeta = members.find((m) => Number(m.buyer_id) === Number(memberId)) || null;

    const now = new Date();
    const currentMonthKey = monthKeyOf(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const directKidsOfTarget = tree.childrenMap.get(String(memberId)) || [];
    const isRootMember = Number(memberId) === Number(rootId);
    const orderedLocalLegs = assignLegLetters(directKidsOfTarget, { useStoredLeg: isRootMember });

    const legBuckets = new Map();
    const childOwnership = new Map();

    orderedLocalLegs.forEach(({ head: kid, letter: code }) => {
      const bucket = {
        legCode: code,
        legLabel: `Leg ${code}`,
        headId: kid.buyer_id,
        headName: kid.name || `Associate #${kid.buyer_id}`,
        count: 0,
        joinings: []
      };
      legBuckets.set(String(kid.buyer_id), bucket);

      const q = [String(kid.buyer_id)];
      const seen = new Set([String(memberId)]);
      for (let qi = 0; qi < q.length; qi += 1) {
        const currId = q[qi];
        if (seen.has(currId)) continue;
        seen.add(currId);
        childOwnership.set(currId, String(kid.buyer_id));

        const subKids = tree.childrenMap.get(currId) || [];
        for (const sk of subKids) {
          const skId = String(sk.buyer_id);
          if (!seen.has(skId)) q.push(skId);
        }
      }
    });

    const idsToLoad = new Set([memberId, ...childOwnership.keys()]);
    if (targetNode?.parent_id) idsToLoad.add(targetNode.parent_id);

    const identityMap = await loadIdentities([...idsToLoad]);
    let identity = identityMap.get(memberId) || {};

    const enriched = await enrichMemberIdentityFromPortal(rootId, memberId, identity);
    if (enriched) {
      identity = {
        ...identity,
        name: identity.name || enriched.name,
        proposer_id: identity.proposer_id || enriched.proposer_id,
        proposer_name: identity.proposer_name || enriched.proposer_name,
        sponsor_id: identity.sponsor_id || enriched.sponsor_id,
        sponsor_name: identity.sponsor_name || enriched.sponsor_name,
        mobile_no: pickMobile(identity) || enriched.mobile_no,
        mobile: pickMobile(identity) || enriched.mobile_no,
        district: identity.district || enriched.district,
        state: identity.state || enriched.state,
        tehsil: identity.tehsil || enriched.tehsil,
        post_village: identity.post_village || enriched.post_village,
        pincode: identity.pincode || enriched.pincode,
        address: identity.address || enriched.address,
        curr_pin: identity.curr_pin || enriched.curr_pin,
        max_pin: identity.max_pin || enriched.max_pin,
        highest_pin: identity.highest_pin || enriched.max_pin,
        kyc_status: identity.kyc_status || enriched.kyc_status,
        photo_url: pickPhoto(identity) || enriched.photo_url,
        join_date: identity.join_date || enriched.join_date
      };
    }

    let raw = null;
    if (!targetNode) {
      const nodeRows = await select('SELECT * FROM rcm_downline_nodes WHERE buyer_id = :memberId LIMIT 1', { memberId });
      raw = nodeRows[0] || null;
    }
    const node = targetNode || (raw ? normalizeNode(raw, 0) : null);

    if (!identity.buyer_id && !identity.name && !node) {
      return sendSafe(res, 404, { success: false, message: 'Member profile not found.' });
    }

    const sponsorId = firstDefined(identity.sponsor_id, node?.sponsor_id, node?.parent_id) || null;
    const proposerId = firstDefined(identity.proposer_id, node?.proposer_id) || null;

    const extraLookupIds = [];
    if (sponsorId && !identityMap.has(Number(sponsorId)) && !tree.nodeMap.has(String(sponsorId))) {
      extraLookupIds.push(Number(sponsorId));
    }
    if (proposerId && !identityMap.has(Number(proposerId)) && !tree.nodeMap.has(String(proposerId))) {
      extraLookupIds.push(Number(proposerId));
    }
    if (extraLookupIds.length > 0) {
      const extraMap = await loadIdentities(extraLookupIds);
      extraMap.forEach((v, k) => identityMap.set(k, v));
    }

    const resolvePersonName = (id, explicitName) => {
      if (explicitName) return explicitName;
      if (!id) return null;
      const numId = Number(id);
      return identityMap.get(numId)?.name || tree.nodeMap.get(String(id))?.name || null;
    };

    const sponsorName = resolvePersonName(sponsorId, firstDefined(identity.sponsor_name, node?.sponsor_name));
    const proposerName = resolvePersonName(proposerId, firstDefined(identity.proposer_name, node?.proposer_name));

    for (const [descId, ownerChildId] of childOwnership.entries()) {
      const descIdNum = Number(descId);
      const descIdentity = identityMap.get(descIdNum) || {};
      const descNode = tree.nodeMap.get(descId);

      const joinInfo = resolveEffectiveJoinDate(descIdentity, descNode);
      if (!joinInfo) continue;

      const joined = joinInfo.date;
      if (joined < monthStart || joined >= nextMonthStart) continue;

      const bucket = legBuckets.get(ownerChildId);
      if (!bucket) continue;

      const descSponsorId = firstDefined(descIdentity.sponsor_id, descNode?.sponsor_id, descNode?.parent_id) || null;
      const descProposerId = firstDefined(descIdentity.proposer_id, descNode?.proposer_id) || null;

      bucket.count += 1;
      bucket.joinings.push({
        buyer_id: descIdNum,
        name: descIdentity.name || descNode?.name || `Associate #${descIdNum}`,
        mobile_no: pickMobile(descIdentity) || null,
        join_date: formatDateOnly(joined),
        join_date_source: joinInfo.source,
        leg_code: bucket.legCode,
        leg_type: bucket.legLabel,
        sponsor_id: descSponsorId ? String(descSponsorId) : null,
        sponsor_name: resolvePersonName(descSponsorId, firstDefined(descIdentity.sponsor_name, descNode?.sponsor_name)),
        proposer_id: descProposerId ? String(descProposerId) : null,
        proposer_name: resolvePersonName(descProposerId, firstDefined(descIdentity.proposer_name, descNode?.proposer_name)),
        self_pv: descNode ? descNode.self_pv : 0,
        repurchase_amt: descNode ? descNode.repurchase_amt : 0
      });
    }

    const legsSummary = {};
    const legJoiningsList = [];
    for (const bucket of legBuckets.values()) {
      bucket.joinings.sort((a, b) => String(b.join_date).localeCompare(String(a.join_date)) || b.buyer_id - a.buyer_id);
      legsSummary[bucket.legCode] = {
        leg_code: bucket.legCode,
        leg_type: bucket.legLabel,
        head_id: bucket.headId,
        head_name: bucket.headName,
        new_joinings_count: bucket.count,
        joinings: bucket.joinings
      };
      legJoiningsList.push(...bucket.joinings);
    }

    const legAJoinings = legsSummary.A?.joinings || [];
    const legBJoinings = legsSummary.B?.joinings || [];
    const legACount = legsSummary.A?.new_joinings_count || 0;
    const legBCount = legsSummary.B?.new_joinings_count || 0;

    const name = identity.name || node?.name || `Associate #${memberId}`;
    const terminated = node && node.status === 0;
    const legLetter = memberMeta?.leg_letter || (isRootMember ? 'ROOT' : null);
    const actualDirectCount = Math.max(directKidsOfTarget.length, node ? node.children_count : 0);

    return sendSafe(res, 200, {
      success: true,
      data: {
        buyer_id: memberId,
        name,
        applicant_name: name,
        join_date: identity.join_date || node?.join_date || null,
        kyc_status: node?.kyc_status || identity.kyc_status || (terminated ? 'Terminated' : null),
        curr_pin: identity.curr_pin || null,
        max_pin: identity.max_pin || null,
        highest_pin: identity.highest_pin || identity.max_pin || 'ASSOCIATE BUYER',
        pin: identity.highest_pin || identity.max_pin || 'ASSOCIATE BUYER',
        leg_letter: legLetter,
        leg_type: legLetter && legLetter !== 'ROOT' ? `Leg ${legLetter}` : null,
        sponsor_id: sponsorId ? String(sponsorId) : null,
        sponsor_name: sponsorName,
        proposer_id: proposerId ? String(proposerId) : null,
        proposer_name: proposerName,
        address_line: identity.address || null,
        post_village: identity.post_village || null,
        tehsil: identity.tehsil || null,
        city: identity.city || null,
        district: identity.district || null,
        state: identity.state || null,
        pincode: identity.pincode || null,
        mobile: pickMobile(identity),
        mobile_no: pickMobile(identity),
        self_pv: node ? node.self_pv : 0,
        current_pv: node ? node.self_pv : 0,
        repurchase_amt: node ? node.repurchase_amt : 0,
        total_group_pv: node ? node.total_group_pv : 0,
        children_count: actualDirectCount,
        status: node ? node.status : 1,
        photo_url: pickPhoto(identity),
        this_month_key: currentMonthKey,
        this_month_joinings: {
          total: legJoiningsList.length,
          legA: { count: legACount, joinings: legAJoinings },
          legB: { count: legBCount, joinings: legBJoinings },
          byLeg: legsSummary,
          allJoinings: legJoiningsList
        }
      }
    });
  } catch (error) {
    console.error('Error in getMemberFullProfile:', error.message);
    return sendSafe(res, 500, { success: false, message: 'Failed to load member profile.' });
  }
};

// ---------------------------------------------------------------------------
// GET /search
// ---------------------------------------------------------------------------
exports.searchLifelines = async (req, res) => {
  setNoStore(res);
  const rootId = resolveRoot(req, res, req.query.rootBuyerId || req.query.rootBuyerID || req.query.buyerId);
  if (!rootId) return undefined;

  const rawQ = String(req.query.q || req.query.search || req.query.query || '').trim();
  if (!rawQ) return sendSafe(res, 400, { success: false, message: 'Search query is required.' });

  const limit = Math.min(Math.max(safeNumber(req.query.limit, 20), 1), 50);
  const isNumericId = /^\d+$/.test(rawQ);
  const qLower = rawQ.toLowerCase();
  const qTokens = qLower.split(/\s+/).filter(Boolean);

  try {
    const tree = await loadTree(rootId);
    if (res.headersSent || res.writableEnded) return undefined;

    const { members } = analyzeTree(tree, rootId);
    const legMap = new Map(members.map((m) => [m.buyer_id, m.leg_type]));

    const scored = [];
    for (const node of tree.nodeMap.values()) {
      const idStr = String(node.buyer_id);
      const nameLower = String(node.name || '').toLowerCase();

      if (isNumericId) {
        if (idStr === rawQ) scored.push({ node, rank: 0 });
        else if (idStr.startsWith(rawQ)) scored.push({ node, rank: 1 });
        else if (idStr.includes(rawQ)) scored.push({ node, rank: 2 });
      } else if (nameLower) {
        if (nameLower === qLower) scored.push({ node, rank: 0 });
        else if (nameLower.startsWith(qLower)) scored.push({ node, rank: 1 });
        else if (qTokens.every((t) => nameLower.includes(t))) scored.push({ node, rank: 2 });
      }
    }

    scored.sort((a, b) =>
      a.rank - b.rank ||
      b.node.total_group_pv - a.node.total_group_pv ||
      b.node.pv - a.node.pv ||
      a.node.buyer_id - b.node.buyer_id
    );

    const matchedNodes = scored.slice(0, limit).map((s) => s.node);
    const identities = await loadIdentities(matchedNodes.map((n) => n.buyer_id));

    const filtered = matchedNodes.map((node) => {
      const idRow = identities.get(node.buyer_id) || {};
      const pin = pickPin(idRow) || 'ASSOCIATE BUYER';
      const actualKids = Math.max((tree.childrenMap.get(String(node.buyer_id)) || []).length, node.children_count || 0);
      return {
        id: node.buyer_id,
        buyer_id: node.buyer_id,
        parent_id: node.parent_id,
        depth: node.depth,
        name: idRow.name || node.name || `Associate #${node.buyer_id}`,
        highest_pin: pin,
        curr_pin: idRow.curr_pin || pin,
        max_pin: idRow.max_pin || pin,
        mobile_no: pickMobile(idRow) || null,
        district: idRow.district || null,
        state: idRow.state || null,
        leg_type: legMap.get(node.buyer_id) || node.leg_type || null,
        level: node.level ?? node.depth,
        status: node.status,
        statusLabel: node.status === 1 ? 'ACTIVE' : 'TERMINATED',
        self_pv: node.self_pv,
        current_pv: node.self_pv,
        repurchase_amt: node.repurchase_amt,
        total_group_pv: node.total_group_pv,
        children_count: actualKids,
        has_children: actualKids > 0,
        photo_url: pickPhoto(idRow)
      };
    });

    if (res.headersSent || res.writableEnded) return undefined;

    let selectedPath = null;
    if (filtered.length === 1 && isNumericId && String(filtered[0].buyer_id) === rawQ) {
      try {
        selectedPath = await buildAncestorPath(rootId, filtered[0].buyer_id);
      } catch {
        selectedPath = null;
      }
    }

    return sendSafe(res, 200, { success: true, data: filtered, selectedPath });
  } catch (error) {
    if (res.headersSent || res.writableEnded) return undefined;
    console.warn('Search fallback triggered:', error.message);
    try {
      const helperRes = await searchLifelineMembers({ rootBuyerId: rootId, searchQuery: rawQ, limit });
      return sendSafe(res, 200, { success: true, data: Array.isArray(helperRes) ? helperRes : [], selectedPath: null });
    } catch {
      return sendSafe(res, 200, { success: true, data: [], selectedPath: null });
    }
  }
};

exports.getMemberPath = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, req.query.rootBuyerId || req.query.buyerId);
    if (!rootId) return undefined;
    const memberId = safeNumber(req.params.memberId || req.query.memberId, 0);
    if (!memberId) return sendSafe(res, 400, { success: false, message: 'memberId is required.' });
    if (!(await isInSubtree(rootId, memberId))) {
      return sendSafe(res, 404, { success: false, message: 'Member not found in your tree.' });
    }
    const path = await buildAncestorPath(rootId, memberId);
    return sendSafe(res, 200, { success: true, data: path });
  } catch {
    return sendSafe(res, 200, { success: true, data: [] });
  }
};

// ---------------------------------------------------------------------------
// GET /territory/:buyerId
// ---------------------------------------------------------------------------
exports.getTerritorySummary = async (req, res) => {
  try {
    setNoStore(res);
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
    return sendSafe(res, 200, {
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
    return sendSafe(res, 500, { success: false, message: 'Failed to fetch territory summary.' });
  }
};

// ---------------------------------------------------------------------------
// GET /followup/:buyerId
// ---------------------------------------------------------------------------
exports.getFollowupList = async (req, res) => {
  try {
    setNoStore(res);
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
    return sendSafe(res, 200, { success: true, data });
  } catch (error) {
    console.error('Error in getFollowupList:', error.message);
    return sendSafe(res, 200, { success: true, data: [] });
  }
};

// ---------------------------------------------------------------------------
// GET /turnover-history
// ---------------------------------------------------------------------------
exports.getTurnoverHistory = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;
    const rows = await fetchTurnoverRows(rootId, 12);
    return sendSafe(res, 200, { success: true, data: rows });
  } catch {
    return sendSafe(res, 500, { success: false, message: 'Failed to fetch turnover history.' });
  }
};

// ---------------------------------------------------------------------------
// POST /photo
// ---------------------------------------------------------------------------
exports.updateCustomPhoto = async (req, res) => {
  try {
    setNoStore(res);
    const rootId = resolveRoot(req, res, null);
    if (!rootId) return undefined;

    const targetId = safeNumber(req.body?.buyerId || req.body?.buyer_id, rootId) || rootId;
    const photoUrl = String(req.body?.custom_photo_url || req.body?.photoUrl || req.body?.photo_url || '').trim();

    if (!photoUrl) return sendSafe(res, 400, { success: false, message: 'custom_photo_url is required.' });
    if (!photoUrl.startsWith('http://') && !photoUrl.startsWith('https://') && !photoUrl.startsWith('/uploads/')) {
      return sendSafe(res, 400, { success: false, message: 'Invalid photo URL.' });
    }
    if (!(await isInSubtree(rootId, targetId))) {
      return sendSafe(res, 403, { success: false, message: 'You can only update photos in your own tree.' });
    }

    const member = await RcmIdentity.findByPk(targetId);
    if (!member) return sendSafe(res, 404, { success: false, message: 'Member not found.' });

    member.custom_photo_url = photoUrl;
    member.updated_at = new Date();
    await member.save();

    return sendSafe(res, 200, {
      success: true,
      message: 'Custom photo updated.',
      data: { buyer_id: targetId, custom_photo_url: photoUrl }
    });
  } catch {
    return sendSafe(res, 400, { success: false, message: 'Failed to update custom photo.' });
  }
};

// ---------------------------------------------------------------------------
// Canonical Aliases & Exports
// ---------------------------------------------------------------------------
exports.getOverview = exports.getLifelinesOverview;
exports.getTreeChildren = exports.getLifelinesChildren;
exports.getMemberDetail = exports.getMemberFullProfile;
exports.assistantQuery = exports.getAssistantQuery;
exports.getNewJoinings = getNewJoinings;
exports.newJoinings = getNewJoinings;
exports.getNewJoiningsList = getNewJoinings;