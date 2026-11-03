'use strict';

/**
 * rcmGroupScraper.js
 *
 * Stage 1 (syncOverviewFast)          -> root profile + photo + direct legs + official PV & Repurchase Amt
 * Stage 2 (startBackgroundTreeCrawler) -> full downline hierarchy (BFS), extracts Self PV & Re-Purchase Amt
 * On-demand (fetchChildrenOnDemand)   -> expand a single branch from the UI
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
const USER_DATA_URL = `${ECOM_BASE}/user/user-data`;

// ---- Crawl pacing -----------------------------------------------------------
const CRAWL_CONCURRENCY = 2;
const NODE_DELAY_MIN_MS = 200;
const NODE_DELAY_MAX_MS = 450;
const COOLDOWN_EVERY_N_FETCHES = 35;
const COOLDOWN_MIN_MS = 1200;
const COOLDOWN_MAX_MS = 2000;
const FETCH_TRIES = 3;
const BACKOFF_STEP_MS = 600;

const NODE_FRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

const activeCrawls = new Map();

// ---- Helpers ----------------------------------------------------------------
const parseNum = (v) => {
  if (v === null || v === undefined) return 0;
  const cleaned = String(v).replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? 0 : num;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const jitter = (max = 200) => randomBetween(0, max);

/**
 * Robust Raw ID parser (supports RCM standard ab_no, ab_id, dist_no, buyer_id)
 */
const getRawId = (obj) => {
  if (!obj) return null;
  const raw = obj.ab_no ?? obj.ab_id ?? obj.dist_no ?? obj.distno ?? obj.distributor_no ?? obj.buyer_id ?? obj.id;
  return raw === undefined || raw === null || raw === '' ? null : String(raw).trim();
};

/**
 * Regex title parser for downline items
 * Example: "[32739154] Abhisar Sugandhi [Status: KYC OK | Re-Purchase Amt. : 1829.00 | P.V.: 936.00]"
 */
function extractAmountsFromTitle(rawText) {
  const text = String(rawText || '');
  const repurchaseMatch = text.match(/Re-?Purchase\s*Amt\.?\s*:\s*([\d,.]+)/i);
  const pvMatch = text.match(/P\.?V\.?\s*:\s*([\d,.]+)/i);

  const repurchaseAmt = repurchaseMatch ? parseNum(repurchaseMatch[1]) : 0;
  const selfPv = pvMatch ? parseNum(pvMatch[1]) : 0;

  return { repurchaseAmt, selfPv };
}

function parseJoinDate(d) {
  if (!d) return null;
  if (typeof d === 'string' && d.includes('/')) {
    const parts = d.split('/');
    if (parts.length === 3) {
      return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    }
  }
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
}

/**
 * Resilient HTTP GET: includes Resource: web headers alongside Bearer token & cookie.
 */
async function safeGet(session, url) {
  try {
    const headers = {
      'Authorization': session?.client?.defaults?.headers?.common['Authorization'] || (session?.token ? `Bearer ${session.token}` : ''),
      'Cookie': session?.client?.defaults?.headers?.common['Cookie'] || '',
      'Origin': 'https://www.rcmworld.com',
      'Referer': 'https://www.rcmworld.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Resource': 'web',
      'resource': 'web',
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

function extractDownlineList(res) {
  if (!res || !res.data) return [];
  const d = res.data;
  if (Array.isArray(d.data?.downlineData)) return d.data.downlineData;
  if (Array.isArray(d.downlineData)) return d.downlineData;
  if (Array.isArray(d.data?.data)) return d.data.data;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d)) return d;
  return [];
}

/**
 * Supports direct arrays and paginated Laravel object responses (d.data.data)
 */
function extractPurchaseVolumeList(res) {
  if (!res || !res.data) return [];
  const d = res.data;
  if (Array.isArray(d.data?.data)) return d.data.data;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d.data?.list)) return d.data.list;
  if (Array.isArray(d.data?.rows)) return d.data.rows;
  if (Array.isArray(d.data?.records)) return d.data.records;
  if (Array.isArray(d.data?.members)) return d.data.members;
  if (Array.isArray(d.data?.downlineData)) return d.data.downlineData;
  if (Array.isArray(d)) return d;
  return [];
}

function extractPv(obj) {
  if (!obj) return 0;
  if (typeof obj === 'number') return obj;
  return parseNum(
    obj.tot_pv ||
    obj.purchase_volume ||
    obj.pur_vol ||
    obj.pur_volume ||
    obj.tot_group_pv ||
    obj.group_pv ||
    obj.total_pv ||
    obj.tot_bv ||
    obj.total_bv ||
    obj.pv ||
    obj.self_pv ||
    obj.current_pv ||
    0
  );
}

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

function sanitizeName(raw) {
  return String(raw || '')
    .replace(/^terminated\s*-\s*/i, '')
    .replace(/\[.*?\]/g, '')
    .trim();
}

async function safeUpsert(model, payload, label) {
  if (!model || !model.upsert) return;
  try {
    await model.upsert(payload);
  } catch (err) {
    console.warn(`[DB UPSERT WARN] ${label}:`, err.message);
  }
}

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
 * Official PV Only Endpoint
 */
async function fetchPvOnly(session, distNo, month, year) {
  try {
    const url = `${ECOM_BASE}/user/business-info/your-purchase-volume/pvOnly?distno=${distNo}&month=${month}&year=${year}`;
    const res = await safeGet(session, url);
    if (res.status === 200 && res.data) {
      const d = res.data;
      const raw = d.data?.pv ?? d.data?.total_pv ?? d.data?.tot_pv ?? d.data?.purchase_volume ?? d.data?.self_pv ?? d.data ?? d.pv;
      return parseNum(raw);
    }
  } catch (e) {
    // optional endpoint
  }
  return 0;
}

/**
 * Verified RCM Purchase Volume & Direct Legs Table Endpoint:
 * GET https://ecomapi.rcmworld.com/api/user/business-info/your-purchase-volume/all/1/10?distno={distNo}&month={month}&year={year}
 */
async function fetchVolumeTable(session, distNo, month, year) {
  const url = `${ECOM_BASE}/user/business-info/your-purchase-volume/all/1/10?distno=${distNo}&month=${month}&year=${year}`;
  const res = await safeGet(session, url);
  if (res.status !== 200) {
    const fallbackUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume?distno=${distNo}&month=${month}&year=${year}`;
    const fallbackRes = await safeGet(session, fallbackUrl);
    if (fallbackRes.status !== 200) {
      console.warn(`[VOLUME] HTTP ${res.status} and fallback HTTP ${fallbackRes.status} for ${distNo} ${month}/${year}`);
      return [];
    }
    return extractPurchaseVolumeList(fallbackRes);
  }
  return extractPurchaseVolumeList(res);
}

function findLegRow(rows, leg, index) {
  if (!rows || rows.length === 0) return null;
  // 1. By ID matching
  const byId = rows.find((r) => {
    const rid = getRawId(r);
    return rid !== null && String(rid) === String(leg.distno);
  });
  if (byId) return byId;

  // 2. By Leg character matching (A / B)
  const byLegLetter = rows.find((r) => r.leg && leg.leg && String(r.leg).toUpperCase() === String(leg.leg).toUpperCase());
  if (byLegLetter) return byLegLetter;

  // 3. Fallback to index position (Row 0 -> Leg A, Row 1 -> Leg B)
  if (index !== undefined && rows[index]) {
    return rows[index];
  }
  return null;
}

/**
 * Verified RCM User Profile & Pin Levels API:
 * GET https://ecomapi.rcmworld.com/api/user/business-info/your-purchase-volume/profile?distno={distNo}&month={month}&year={year}
 */
async function fetchUserProfile(session, distNo, month, year) {
  try {
    const now = new Date();
    const m = month || (now.getMonth() + 1);
    const y = year || now.getFullYear();
    const profileUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume/profile?distno=${distNo}&month=${m}&year=${y}`;
    const [profileRes, userDataRes, storeRes] = await Promise.all([
      safeGet(session, profileUrl),
      safeGet(session, USER_DATA_URL),
      safeGet(session, `${ECOM_BASE}/user/profile/get-all-store`)
    ]);

    const pData = profileRes?.data?.data || {};
    const uData = userDataRes?.data?.data || {};
    const pinData = uData.pin_data || {};

    const photoUrl = pData.user_image || pinData.user_image || uData.photo_url || null;
    const currPin = pData.curr_pin || pinData.pin_description || pinData.pin || uData.curr_pin || 'ASSOCIATE BUYER';
    const maxPin = pData.max_pin || pinData.max_pin || currPin;
    const kycStatus = pData.kyc_status || uData.kyc_status || 'A';
    const joinDate = pData.join_date || uData.join_date || null;
    const terminated = Boolean(pData.terminated || uData.terminated);

    let associateName = pData.dist_name || pData.name || null;
    if (!associateName) {
      const storeList = storeRes?.data?.data || [];
      if (Array.isArray(storeList) && storeList.length > 0) {
        const matched = storeList.find(s => String(s.ab_id || s.distno) === String(distNo)) || storeList[0];
        associateName = matched?.name || matched?.dist_name || null;
      }
    }

    const selfPv = parseNum(pData.self_purchase || pData.self_pv || pData.self_pur || uData.self_pv || 0);

    return {
      name: sanitizeName(associateName) || null,
      curr_pin: currPin,
      max_pin: maxPin,
      pin_level: currPin,
      kyc_status: kycStatus,
      join_date: joinDate,
      terminated,
      photo_url: photoUrl,
      self_pv: selfPv
    };
  } catch (err) {
    console.warn(`[USER PROFILE FETCH WARN] ${distNo}:`, err.message);
    return {};
  }
}

/**
 * 1. Stage 1: Fast Sync
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

  const downlineRes = await safeGet(session, `${DOWNLINE_API_URL}?dist_no=${buyerId}`);
  if (downlineRes.status !== 200) {
    console.warn(`[FAST SYNC] downline API returned HTTP ${downlineRes.status} for ${buyerId}`);
  }
  const downlineList = extractDownlineList(downlineRes);
  console.log(`[FAST SYNC] Extracted ${downlineList.length} direct legs from downlineData for: ${buyerId}`);

  let directLegs = downlineList
    .map((item, index) => {
      const rawId = getRawId(item);
      if (rawId === null) return null;
      const status = normalizeNumericStatus(item);
      const titleText = item.title || item.dist_name || item.name || '';
      const { repurchaseAmt, selfPv } = extractAmountsFromTitle(titleText);
      const legChar = item.leg || (index === 0 ? 'A' : index === 1 ? 'B' : null);

      return {
        distno: String(rawId),
        name: sanitizeName(titleText),
        status,
        statusLabel: status === 1 ? 'ACTIVE' : 'TERMINATED',
        kyc_status: item.kyc_status || 'A',
        self_pv: selfPv,
        repurchase_amt: repurchaseAmt,
        leg: legChar
      };
    })
    .filter(Boolean);

  const [profile, pvOnlyCurrent, pvOnlyPrev, currentRows, prevRows] = await Promise.all([
    fetchUserProfile(session, buyerId, currentMonth, currentYear),
    fetchPvOnly(session, buyerId, currentMonth, currentYear),
    fetchPvOnly(session, buyerId, prevMonth, prevYear),
    fetchVolumeTable(session, buyerId, currentMonth, currentYear),
    fetchVolumeTable(session, buyerId, prevMonth, prevYear)
  ]);

  const associateName = profile.name || `Associate #${buyerId}`;
  const pinLevel = profile.curr_pin || 'ASSOCIATE BUYER';
  const photoUrl = profile.photo_url || null;

  const legA = directLegs.find((l) => l.leg === 'A') || directLegs[0] || null;
  const legB = directLegs.find((l) => l.leg === 'B') || directLegs[1] || null;

  const legPvFor = (rows, leg, index) => {
    if (!leg) return 0;
    const row = findLegRow(rows, leg, index);
    return row ? extractPv(row) : (leg.self_pv || 0);
  };

  // Parse root user amounts from downlineRes root object
  const rootText = downlineRes.data?.data?.title || downlineRes.data?.data?.dist_name || downlineRes.data?.title || '';
  const rootAmounts = extractAmountsFromTitle(rootText);

  const selfPvCurrent = profile.self_pv || rootAmounts.selfPv || 0;
  const legACurrent = legPvFor(currentRows, legA, 0);
  const legBCurrent = legPvFor(currentRows, legB, 1);
  const computedTotalPv = legACurrent + legBCurrent + selfPvCurrent;
  const totalPvCurrent = Math.max(computedTotalPv, pvOnlyCurrent);

  const selfPvPrevRow = prevRows.find((r) => String(getRawId(r)) === String(buyerId));
  const selfPvPrev = selfPvPrevRow ? parseNum(selfPvPrevRow.self_pv || selfPvPrevRow.current_pv) : 0;
  const legAPrev = legPvFor(prevRows, legA, 0);
  const legBPrev = legPvFor(prevRows, legB, 1);
  const computedTotalPvPrev = legAPrev + legBPrev + selfPvPrev;
  const totalPvPrev = Math.max(computedTotalPvPrev, pvOnlyPrev);

  directLegs = directLegs.map((leg, index) => {
    const row = findLegRow(currentRows, leg, index);
    return {
      ...leg,
      pv: row ? extractPv(row) : (leg.self_pv || 0),
      self_pv: row ? parseNum(row.self_pv || row.current_pv) : leg.self_pv,
      pvKnown: Boolean(row)
    };
  });

  console.log(`[FAST SYNC] ${associateName} (${pinLevel}) - Current(${currentMonthKey}) PV: ${totalPvCurrent} - Prev(${prevMonthKey}) PV: ${totalPvPrev}`);

  await safeUpsert(RcmIdentity, {
    buyer_id: String(buyerId),
    name: associateName,
    highest_pin: profile.max_pin || pinLevel,
    pin: profile.curr_pin || pinLevel,
    kyc_status: profile.kyc_status || 'A',
    join_date: parseJoinDate(profile.join_date),
    photo_url: photoUrl
  }, 'RcmIdentity');

  // CRITICAL FIX: DO NOT set children_synced_at here so crawler doesn't get skipped!
  await safeUpsert(DownlineNode, {
    buyer_id: String(buyerId),
    parent_id: null,
    name: associateName,
    status: profile.terminated ? 0 : 1,
    self_pv: selfPvCurrent,
    current_pv: selfPvCurrent,
    repurchase_amt: rootAmounts.repurchaseAmt,
    total_group_pv: totalPvCurrent,
    level: 0
  }, 'DownlineNode root');

  for (const leg of directLegs) {
    const payload = {
      buyer_id: leg.distno,
      parent_id: String(buyerId),
      name: leg.name,
      status: leg.status,
      self_pv: leg.self_pv || 0,
      current_pv: leg.self_pv || 0,
      repurchase_amt: leg.repurchase_amt || 0,
      total_group_pv: leg.pv || 0,
      level: 1
    };
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
    currPin: profile.curr_pin || pinLevel,
    maxPin: profile.max_pin || pinLevel,
    pinLevel,
    kycStatus: profile.kyc_status || 'A',
    joinDate: profile.join_date || null,
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
 */
function startBackgroundTreeCrawler({ session, buyerId, directLegs = [], month, year, io, forceFullCrawl = true }) {
  const root = String(buyerId);

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
    console.log(`[TREE CRAWLER] Starting active BFS indexing for root: ${root}`);

    // Queue initialized with root so BFS systematically cascades downline
    const queue = [{ distNo: root, depth: 0 }];
    const visited = new Set([root]);

    let aborted = false;
    let fetchesSinceCooldown = 0;

    const processNode = async (node) => {
      try {
        const children = await fetchDownline(session, node.distNo);

        for (const child of children) {
          const rawId = getRawId(child);
          if (rawId === null) continue;
          const childId = String(rawId);
          if (visited.has(childId)) continue;
          visited.add(childId);

          const titleText = child.title || child.dist_name || child.name || '';
          const { repurchaseAmt, selfPv } = extractAmountsFromTitle(titleText);
          const status = normalizeNumericStatus(child);

          await safeUpsert(DownlineNode, {
            buyer_id: childId,
            parent_id: node.distNo,
            name: sanitizeName(titleText),
            status,
            self_pv: selfPv,
            current_pv: selfPv,
            repurchase_amt: repurchaseAmt,
            level: node.depth + 1
          }, `DownlineNode ${childId}`);

          const nowScrape = new Date();
          const currentMonthKeyScrape = `${nowScrape.getFullYear()}${String(nowScrape.getMonth() + 1).padStart(2, '0')}`;
          await safeUpsert(MemberMonthlySnapshot, {
            buyer_id: Number(childId),
            month_key: currentMonthKeyScrape,
            pv: selfPv,
            purchase_amt: repurchaseAmt,
            leg_type: child.leg || 'Leg A',
            status
          }, `MemberMonthlySnapshot ${childId}`);

          state.count++;
          queue.push({ distNo: childId, depth: node.depth + 1 });
        }

        if (DownlineNode && DownlineNode.update) {
          await DownlineNode.update(
            { children_synced_at: new Date() },
            { where: { buyer_id: String(node.distNo) } }
          ).catch(() => null);
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

        if (state.count % 25 === 0 || queue.length === 0) {
          console.log(`[TREE CRAWLER] ${root}: indexed ${state.count} members... (queue remaining: ${queue.length})`);
        }

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

    const children = await fetchDownline(session, parentId);

    let saved = 0;
    for (const child of children) {
      const rawId = getRawId(child);
      if (rawId === null) continue;

      const titleText = child.title || child.dist_name || child.name || '';
      const { repurchaseAmt, selfPv } = extractAmountsFromTitle(titleText);
      const status = normalizeNumericStatus(child);

      await safeUpsert(DownlineNode, {
        buyer_id: String(rawId),
        parent_id: String(parentId),
        name: sanitizeName(titleText),
        status,
        self_pv: selfPv,
        current_pv: selfPv,
        repurchase_amt: repurchaseAmt,
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
      curr_pin: overview.currPin,
      highest_pin: overview.maxPin,
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

async function scrapeYourGroup(session, buyerId, macroInfo) {
  return startBackgroundTreeCrawler({
    session,
    buyerId,
    directLegs: macroInfo?.directLegs || macroInfo?.legs || [],
    forceFullCrawl: true
  });
}

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
  syncGroupData: syncOverviewFast,
  extractAmountsFromTitle
};