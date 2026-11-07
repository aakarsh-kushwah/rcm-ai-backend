'use strict';

/**
 * rcmGroupScraper.js
 * High-performance dual sync:
 *  - Stage 1 (Fast Sync): Instant root info, direct legs, and macro PV.
 *  - Stage 2a (Live Skeleton): Walks ONLY branches with group PV > 0 (sub-minute exact turnover calculation).
 *  - Stage 2b (Structure Crawl): Full hierarchy crawl with database schema integrity.
 */

const axios = require('axios');
let models = {};
try {
  models = require('../models');
} catch (e) {
  console.warn('[MODEL LOAD NOTICE]:', e.message);
}

const { DownlineNode, MemberMonthlySnapshot, RcmIdentity, RcmMonthlyTurnoverHistory } = models;

let activeView = null;
try {
  activeView = require('./rcmActiveView');
} catch (e) {
  console.warn('[ACTIVE VIEW NOTICE]:', e.message);
}

const ECOM_BASE = 'https://ecomapi.rcmworld.com/api';
// [FIXED]: Was '/user/profile/get-distributor-downline' (404 Error) -> now correct endpoint:
const DOWNLINE_API_URL = `${ECOM_BASE}/user/downline/get-distributor-downline`;
const DIST_INFO_URL = `${ECOM_BASE}/user/profile/get-distributor-info`;
const USER_DATA_URL = `${ECOM_BASE}/user/cart/user-data`;

const envNum = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const CRAWL_CONCURRENCY = 2;
const NODE_DELAY_MIN_MS = 100;
const NODE_DELAY_MAX_MS = 250;
const COOLDOWN_EVERY_N_FETCHES = 35;
const COOLDOWN_MIN_MS = 1200;
const COOLDOWN_MAX_MS = 2000;
const FETCH_TRIES = 3;
const BACKOFF_STEP_MS = 600;

const GAP_START_MS = envNum('RCM_GAP_START_MS', 150);
const GAP_MIN_MS = envNum('RCM_GAP_MIN_MS', 100);
const GAP_MAX_MS = envNum('RCM_GAP_MAX_MS', 3000);
const SKELETON_WORKERS = envNum('RCM_SKELETON_WORKERS', 6);
const PV_PAGE_SIZE = 10;
const MONEY_EPS = 0.05;
const STRUCT_FRESH_MS = envNum('RCM_STRUCT_FRESH_HOURS', 24) * 60 * 60 * 1000;

const activeCrawls = new Map();

const parseNum = (v) => {
  if (v === null || v === undefined) return 0;
  const cleaned = String(v).replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? 0 : num;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const jitter = (max = 200) => randomBetween(0, Math.max(0, max));
const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

let gapMs = GAP_START_MS;
let okStreak = 0;
let nextRequestSlot = 0;

function notePortalStatus(status) {
  if (status === 429 || status >= 500) {
    gapMs = Math.min(GAP_MAX_MS, Math.max(gapMs * 2, 200));
    okStreak = 0;
  } else if (status === 200) {
    okStreak += 1;
    if (okStreak >= 40) {
      okStreak = 0;
      gapMs = Math.max(GAP_MIN_MS, Math.floor(gapMs * 0.85));
    }
  }
}

async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextRequestSlot);
  nextRequestSlot = slot + gapMs + jitter(Math.floor(gapMs * 0.3));
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

const getRawId = (obj) => {
  if (!obj) return null;
  const raw = obj.ab_no ?? obj.ab_id ?? obj.dist_no ?? obj.distno ?? obj.distributor_no ?? obj.buyer_id ?? obj.id ?? obj.key;
  return raw === undefined || raw === null || raw === '' ? null : String(raw).trim();
};

function getNodeText(item) {
  if (!item) return '';
  return String(item.text || item.title || item.label || item.dist_name || item.name || '');
}

function parseJoinDate(d) {
  if (!d) return null;
  if (typeof d === 'string' && d.includes('/')) {
    const parts = d.split('/');
    if (parts.length === 3) {
      const dt = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      return Number.isNaN(dt.getTime()) ? null : dt;
    }
  }
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
}

const firstDefined = (...vals) => {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
};

function extractSponsorInfo(...sources) {
  const pick = (keys) => {
    for (const src of sources) {
      if (!src || typeof src !== 'object') continue;
      for (const k of keys) {
        const v = src[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return null;
  };

  return {
    proposer_id: pick(['proposer_id', 'proposer_no', 'proposer_ab_no', 'proposer_distno', 'proposer']),
    proposer_name: pick(['proposer_name', 'proposer_dist_name', 'proposer_ab_name']),
    sponsor_id: pick(['sponsor_id', 'sponsor_no', 'sponsor_ab_no', 'sponsor_distno', 'sponsor', 'upline_id', 'upline_no']),
    sponsor_name: pick(['sponsor_name', 'sponsor_dist_name', 'sponsor_ab_name', 'upline_name'])
  };
}

function buildIdentityPayload(buyerId, fields) {
  const payload = { buyer_id: String(buyerId) };
  Object.keys(fields || {}).forEach((k) => {
    const v = fields[k];
    if (v !== undefined && v !== null && v !== '') payload[k] = v;
  });
  return payload;
}

function normalizeNumericStatus(item) {
  if (!item) return 1;
  if (typeof item.terminated === 'boolean') {
    return item.terminated ? 0 : 1;
  }
  const isTerminated = Boolean(
    item.status === 'T' ||
    item.status === 0 ||
    item.status === '0' ||
    item.is_terminated ||
    /terminat/i.test(item.remark || '') ||
    /terminated/i.test(getNodeText(item))
  );
  return isTerminated ? 0 : 1;
}

function sanitizeName(raw) {
  return String(raw || '')
    .replace(/^terminated\s*-\s*/i, '')
    .replace(/\[.*?\]/g, '')
    .trim();
}

function parseDownlineItem(item, index) {
  const rawId = getRawId(item);
  if (rawId === null) return null;

  const selfPv = 0; // Tree API sends lifetime cumulative PV, not monthly
  const repurchaseAmt = parseNum(item.amt);
  const status = normalizeNumericStatus(item);
  const sponsor = extractSponsorInfo(item);

  return {
    id: String(rawId),
    name: sanitizeName(item.title || item.name || item.dist_name),
    status,
    selfPv,
    repurchaseAmt,
    leg: item.leg || (index === 0 ? 'A' : index === 1 ? 'B' : null),
    kycStatus: item.kyc_status || 'A',
    joinDate: parseJoinDate(firstDefined(item.join_date, item.doj, item.joining_date)),
    photoUrl: firstDefined(item.user_image, item.photo_url, item.image),
    ...sponsor
  };
}

async function safeGet(session, url) {
  try {
    await throttle();
    const authHeader =
      session?.client?.defaults?.headers?.common?.['Authorization'] ||
      (session?.token ? `Bearer ${session.token}` : '');
    const cookieHeader = session?.client?.defaults?.headers?.common?.['Cookie'] || '';

    const headers = {
      'Origin': 'https://www.rcmworld.com',
      'Referer': 'https://www.rcmworld.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Resource': 'web',
      'resource': 'web',
      'x-user-type': 'ab',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      'Connection': 'keep-alive'
    };
    if (authHeader) headers['Authorization'] = authHeader;
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    let res;
    if (session?.client) {
      res = await session.client.get(url, { headers, timeout: 15000, validateStatus: () => true });
    } else {
      res = await axios.get(url, { headers, timeout: 15000, validateStatus: () => true });
    }
    notePortalStatus(res.status);
    return res;
  } catch (err) {
    notePortalStatus(500);
    return { status: 500, data: null, error: err.message };
  }
}

async function getWithRetry(session, url, label, tries = FETCH_TRIES) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await safeGet(session, url);
    lastStatus = res.status;

    if (res.status === 401 || res.status === 403) throw new Error('SESSION_EXPIRED');
    if (res.status === 200) return res;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) break;

    if (attempt < tries) {
      const base = res.status === 429 ? attempt * BACKOFF_STEP_MS * 3 : attempt * BACKOFF_STEP_MS;
      await sleep(base + jitter());
    }
  }
  throw new Error(`FETCH_FAILED (HTTP ${lastStatus}) ${label}`);
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

async function safeUpsert(model, payload, label) {
  if (!model || !model.upsert) return;
  try {
    await model.upsert(payload);
  } catch (err) {
    console.warn(`[DB UPSERT WARN] ${label}:`, err.message);
  }
}

function createWriter(limit = 8) {
  const queue = [];
  let active = 0;
  const idleWaiters = [];

  const pump = () => {
    while (active < limit && queue.length > 0) {
      const fn = queue.shift();
      active += 1;
      Promise.resolve()
        .then(fn)
        .catch((err) => console.warn('[WRITER WARN]:', err.message))
        .finally(() => {
          active -= 1;
          pump();
          if (active === 0 && queue.length === 0) idleWaiters.splice(0).forEach((r) => r());
        });
    }
  };

  return {
    add(fn) {
      queue.push(fn);
      pump();
    },
    async drain() {
      if (active === 0 && queue.length === 0) return;
      await new Promise((resolve) => idleWaiters.push(resolve));
    }
  };
}

async function persistParsedNode(parsed, parentId, level, rootId, monthKey) {
  const mKey = monthKey || `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const rId = String(rootId || parentId);

  await safeUpsert(DownlineNode, {
    buyer_id: String(parsed.id),
    dist_no: String(parsed.id),
    parent_id: parentId ? String(parentId) : null,
    parent_dist_no: parentId ? String(parentId) : null,
    root_dist_no: rId,
    month_key: mKey,
    name: parsed.name,
    status: parsed.status,
    terminated: parsed.status === 0 ? 1 : 0,
    self_pv: parsed.selfPv || 0,
    current_pv: parsed.selfPv || 0,
    repurchase_amt: parsed.repurchaseAmt || 0,
    level: level || 0,
    kyc_status: parsed.kycStatus || 'A'
  }, `DownlineNode ${parsed.id}`);

  await safeUpsert(RcmIdentity, buildIdentityPayload(parsed.id, {
    name: parsed.name,
    proposer_id: parsed.proposer_id,
    proposer_name: parsed.proposer_name,
    sponsor_id: parsed.sponsor_id,
    sponsor_name: parsed.sponsor_name,
    join_date: parsed.joinDate,
    kyc_status: parsed.kycStatus,
    photo_url: parsed.photoUrl
  }), `RcmIdentity ${parsed.id}`);
}

async function fetchDownline(session, distNo, tries = FETCH_TRIES) {
  const res = await getWithRetry(session, `${DOWNLINE_API_URL}?dist_no=${distNo}`, `downline ${distNo}`, tries);
  return extractDownlineList(res);
}

async function fetchPvOnlyFull(session, distNo, month, year) {
  try {
    const url = `${ECOM_BASE}/user/business-info/your-purchase-volume/pvOnly?distno=${distNo}&month=${month}&year=${year}`;
    const res = await getWithRetry(session, url, `pvOnly ${distNo}`, 2);
    const d = res.data?.data;
    if (!d || typeof d !== 'object') return { ok: false };
    const groupRaw = d.cumulative_pv ?? d.self_total_pv ?? d.total_pv ?? d.tot_pv ?? d.purchase_volume;
    if (groupRaw === undefined || groupRaw === null) return { ok: false };
    return {
      ok: true,
      groupPv: parseNum(groupRaw),
      selfPv: parseNum(d.self_pv),
      lastMonthGroupPv: parseNum(d.last_month_cumulative_pv),
      growth: parseNum(d.growth)
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchPvChildren(session, distNo, month, year) {
  const out = [];
  let page = 1;
  let total = null;

  for (;;) {
    const url = `${ECOM_BASE}/user/business-info/your-purchase-volume/all/${page}/${PV_PAGE_SIZE}?distno=${distNo}&month=${month}&year=${year}`;
    const res = await getWithRetry(session, url, `pv-list ${distNo} p${page}`);
    const rows = extractPurchaseVolumeList(res);
    const t = res.data?.data?.totalCount;
    if (t !== undefined && t !== null && !Number.isNaN(Number(t))) total = Number(t);

    for (const r of rows) {
      const id = getRawId(r);
      if (!id) continue;
      out.push({
        id,
        name: sanitizeName(r.dist_name || r.name),
        sponsor: r.sponsor ?? null,
        groupPv: parseNum(r.pv),
        showDownLink: r.show_down_link
      });
    }

    if (rows.length === 0) break;
    if (total !== null ? out.length >= total : rows.length < PV_PAGE_SIZE) break;
    page += 1;
    if (page > 1000) break;
  }
  return out;
}

async function fetchDistributorInfo(session, distNo) {
  try {
    const res = await getWithRetry(session, `${DIST_INFO_URL}?dist_no=${distNo}`, `info ${distNo}`, 2);
    const d = res.data?.data;
    const row = Array.isArray(d) ? d[0] : d;
    if (!row) return { ok: false };
    return {
      ok: true,
      name: sanitizeName(row.dist_name || row.title),
      amt: parseNum(row.amt),
      pv: parseNum(row.pv),
      terminated: Boolean(row.terminated),
      kycStatus: row.kyc_status || null
    };
  } catch (e) {
    if (e.message === 'SESSION_EXPIRED') throw e;
    return { ok: false, error: e.message };
  }
}

async function fetchVolumeTable(session, distNo, month, year) {
  const url = `${ECOM_BASE}/user/business-info/your-purchase-volume/all/1/10?distno=${distNo}&month=${month}&year=${year}`;
  const res = await safeGet(session, url);
  if (res.status !== 200) {
    const fallbackUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume?distno=${distNo}&month=${month}&year=${year}`;
    const fallbackRes = await safeGet(session, fallbackUrl);
    if (fallbackRes.status !== 200) return [];
    return extractPurchaseVolumeList(fallbackRes);
  }
  return extractPurchaseVolumeList(res);
}

function findLegRow(rows, leg, index) {
  if (!rows || rows.length === 0) return null;
  const byId = rows.find((r) => {
    const rid = getRawId(r);
    return rid !== null && String(rid) === String(leg.distno);
  });
  if (byId) return byId;

  const byLegLetter = rows.find((r) => r.leg && leg.leg && String(r.leg).toUpperCase() === String(leg.leg).toUpperCase());
  if (byLegLetter) return byLegLetter;

  if (index !== undefined && rows[index]) return rows[index];
  return null;
}

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

    if (photoUrl && associateName && RcmIdentity) {
      await RcmIdentity.upsert({
        buyer_id: Number(distNo),
        name: associateName,
        photo_url: photoUrl,
        profile_photo_url: photoUrl,
        curr_pin: currPin,
        max_pin: maxPin,
        highest_pin: maxPin,
        join_date: joinDate,
        kyc_status: kycStatus
      }).catch((err) => console.warn('[IDENTITY SAVE ERROR]:', err.message));
    }

    const selfPv = parseNum(pData.self_purchase || pData.self_pv || pData.self_pur || uData.self_pv || 0);
    const profileGroupPv = extractPv({
      tot_group_pv: pData.tot_group_pv,
      group_pv: pData.group_pv,
      total_pv: pData.total_pv,
      tot_pv: pData.tot_pv
    });
    const sponsor = extractSponsorInfo(pData, uData);

    return {
      name: sanitizeName(associateName) || null,
      curr_pin: currPin,
      max_pin: maxPin,
      pin_level: currPin,
      kyc_status: kycStatus,
      join_date: joinDate,
      terminated,
      photo_url: photoUrl,
      self_pv: selfPv,
      group_pv: profileGroupPv,
      ...sponsor
    };
  } catch (err) {
    console.warn(`[USER PROFILE FETCH WARN] ${distNo}:`, err.message);
    return {};
  }
}

async function syncOverviewFast({ session, buyerId, month, year, io }) {
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
  const downlineList = extractDownlineList(downlineRes);

  const parsedLegs = downlineList
    .map((item, index) => parseDownlineItem(item, index))
    .filter(Boolean);

  let directLegs = parsedLegs.map((p) => ({
    distno: p.id,
    name: p.name,
    status: p.status,
    statusLabel: p.status === 1 ? 'ACTIVE' : 'TERMINATED',
    kyc_status: p.kycStatus || 'A',
    self_pv: p.selfPv,
    repurchase_amt: p.repurchaseAmt,
    leg: p.leg,
    parsed: p
  }));

  const [profile, pvOnlyCurrent, pvOnlyPrev, currentRows, prevRows, rootInfo] = await Promise.all([
    fetchUserProfile(session, buyerId, currentMonth, currentYear),
    fetchPvOnlyFull(session, buyerId, currentMonth, currentYear),
    fetchPvOnlyFull(session, buyerId, prevMonth, prevYear),
    fetchVolumeTable(session, buyerId, currentMonth, currentYear),
    fetchVolumeTable(session, buyerId, prevMonth, prevYear),
    fetchDistributorInfo(session, buyerId)
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

  const rootAmounts = {
    repurchaseAmt: rootInfo.ok ? rootInfo.amt : 0,
    selfPv: rootInfo.ok ? rootInfo.pv : 0
  };

  const selfPvCurrent = profile.self_pv || rootAmounts.selfPv || 0;
  const legACurrent = legPvFor(currentRows, legA, 0);
  const legBCurrent = legPvFor(currentRows, legB, 1);
  const computedTotalPv = legACurrent + legBCurrent + selfPvCurrent;

  const totalPvCurrent = Math.max(computedTotalPv, pvOnlyCurrent.ok ? pvOnlyCurrent.groupPv : 0, profile.group_pv || 0);

  const selfPvPrevRow = prevRows.find((r) => String(getRawId(r)) === String(buyerId));
  const selfPvPrev = selfPvPrevRow ? parseNum(selfPvPrevRow.self_pv || selfPvPrevRow.current_pv) : 0;
  const legAPrev = legPvFor(prevRows, legA, 0);
  const legBPrev = legPvFor(prevRows, legB, 1);
  const computedTotalPvPrev = legAPrev + legBPrev + selfPvPrev;
  const totalPvPrev = Math.max(computedTotalPvPrev, pvOnlyPrev.ok ? pvOnlyPrev.groupPv : 0);

  directLegs = directLegs.map((leg, index) => {
    const row = findLegRow(currentRows, leg, index);
    const rowSelfPv = row ? parseNum(row.self_pv || row.current_pv) : 0;
    const rowRepurchase = row ? parseNum(row.repurchase_amt || row.re_purchase_amt || row.purchase_amt) : 0;
    return {
      ...leg,
      pv: row ? extractPv(row) : 0,
      self_pv: rowSelfPv > 0 ? rowSelfPv : leg.self_pv,
      repurchase_amt: rowRepurchase > 0 ? rowRepurchase : leg.repurchaseAmt,
      pvKnown: Boolean(row)
    };
  });

  await safeUpsert(RcmIdentity, buildIdentityPayload(buyerId, {
    name: associateName,
    highest_pin: profile.max_pin || pinLevel,
    pin: profile.curr_pin || pinLevel,
    kyc_status: profile.kyc_status || 'A',
    join_date: parseJoinDate(profile.join_date),
    photo_url: photoUrl,
    proposer_id: profile.proposer_id,
    proposer_name: profile.proposer_name,
    sponsor_id: profile.sponsor_id,
    sponsor_name: profile.sponsor_name
  }), 'RcmIdentity');

  // Insert Root Node with BOTH column aliases for TiDB compatibility
  await safeUpsert(DownlineNode, {
    buyer_id: String(buyerId),
    dist_no: String(buyerId),
    parent_id: null,
    parent_dist_no: null,
    root_dist_no: String(buyerId),
    month_key: currentMonthKey,
    name: associateName,
    status: profile.terminated ? 0 : 1,
    terminated: profile.terminated ? 1 : 0,
    self_pv: selfPvCurrent,
    current_pv: selfPvCurrent,
    repurchase_amt: rootAmounts.repurchaseAmt,
    total_group_pv: totalPvCurrent,
    level: 0
  }, 'DownlineNode root');

  for (const leg of directLegs) {
    const payload = {
      buyer_id: String(leg.distno),
      dist_no: String(leg.distno),
      parent_id: String(buyerId),
      parent_dist_no: String(buyerId),
      root_dist_no: String(buyerId),
      month_key: currentMonthKey,
      name: leg.name,
      status: leg.status,
      terminated: leg.status === 0 ? 1 : 0,
      self_pv: Number(leg.self_pv || 0),
      current_pv: Number(leg.self_pv || 0),
      repurchase_amt: leg.repurchase_amt || 0,
      total_group_pv: leg.pv || 0,
      level: 1
    };
    if (leg.leg) {
      payload.leg_type = leg.leg;
      payload.leg = leg.leg === 'A' ? 0 : 1;
    }

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

  if (io) {
    io.to(String(buyerId)).emit('overview:live-pv', {
      buyerId: String(buyerId),
      totalPv: totalPvCurrent,
      selfPv: selfPvCurrent,
      closedMonthPv: totalPvPrev,
      month: currentMonth,
      year: currentYear
    });
  }

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
    directLegs
  };
}

async function runSkeletonSync({ session, root, month, year, state, io }) {
  const now = new Date();
  const m = month || (now.getMonth() + 1);
  const y = year || now.getFullYear();
  const isCurrentMonth = m === now.getMonth() + 1 && y === now.getFullYear();
  const monthKey = `${y}${String(m).padStart(2, '0')}`;

  const sk = {
    state: 'CALIBRATING',
    month: m,
    year: y,
    macroPv: 0,
    processedPv: 0,
    residualPv: 0,
    coveragePct: 0,
    liveNodes: 0,
    buyers: 0,
    amountsDone: 0,
    amountsFailed: 0,
    verifiedAmt: 0,
    pendingBuyerPv: 0,
    estLow: null,
    estHigh: null,
    anomalies: 0,
    pvMismatch: 0,
    failedNodes: 0,
    finishedAt: null
  };
  state.skeleton = sk;
  state.phase = 'SKELETON';

  let rootPv = await fetchPvOnlyFull(session, root, m, y);
  if (!rootPv.ok) {
    const prof = await fetchUserProfile(session, root, m, y);
    rootPv = { ok: true, groupPv: prof.group_pv || 0, selfPv: prof.self_pv || 0 };
  }
  sk.macroPv = round2(rootPv.groupPv);

  const writer = createWriter(8);
  const ratios = [];
  const buyersFound = [];
  const viewRows = new Map();
  const failed = [];
  let aborted = false;
  let rootSelfPv = 0;
  let rootKids = [];
  let lastEmit = 0;

  const refresh = () => {
    sk.coveragePct = sk.macroPv > 0 ? Math.min(100, round1((sk.processedPv / sk.macroPv) * 100)) : 100;
    sk.residualPv = round2(sk.macroPv - sk.processedPv);
    const unknownPv = Math.max(0, sk.pendingBuyerPv) + Math.max(0, sk.residualPv);
    if (unknownPv <= MONEY_EPS) {
      sk.estLow = sk.verifiedAmt;
      sk.estHigh = sk.verifiedAmt;
    } else if (ratios.length >= 3) {
      const sorted = [...ratios].sort((a, b) => a - b);
      const lo = sorted[Math.floor(0.1 * (sorted.length - 1))];
      const hi = sorted[Math.floor(0.9 * (sorted.length - 1))];
      sk.estLow = round2(sk.verifiedAmt + unknownPv * lo);
      sk.estHigh = round2(sk.verifiedAmt + unknownPv * hi);
    } else {
      sk.estLow = round2(sk.verifiedAmt + unknownPv * 1.6);
      sk.estHigh = round2(sk.verifiedAmt + unknownPv * 2.1);
    }
  };

  const writeNode = async (fields, isRootNode) => {
    const payload = {
      ...fields,
      buyer_id: String(fields.buyer_id),
      dist_no: String(fields.buyer_id),
      root_dist_no: String(root),
      month_key: monthKey
    };
    if (fields.parent_id) {
      payload.parent_dist_no = String(fields.parent_id);
    }
    await safeUpsert(DownlineNode, payload, `skeleton ${fields.buyer_id}`);
  };

  const stack = [{ type: 'live', id: root, groupPv: sk.macroPv, parent: null, level: 0, name: null, leg: null }];
  let inFlight = 0;

  const processLive = async (item) => {
    const kids = await fetchPvChildren(session, item.id, m, y);
    const kidsSum = kids.reduce((s, k) => s + k.groupPv, 0);
    let selfPv = round2(item.groupPv - kidsSum);
    if (selfPv < 0) selfPv = 0;

    sk.liveNodes += 1;
    sk.processedPv = round2(sk.processedPv + selfPv);
    state.count = Math.max(state.count, sk.liveNodes);

    if (item.id === root) {
      rootSelfPv = selfPv;
      rootKids = kids;
    }

    const payload = {
      buyer_id: item.id,
      total_group_pv: item.groupPv,
      self_pv: selfPv,
      current_pv: selfPv,
      level: item.level,
      parent_id: item.parent ? String(item.parent) : null,
      name: item.name || `Associate #${item.id}`
    };
    if (item.leg) payload.leg_type = item.leg;
    writer.add(() => writeNode(payload, item.parent === null));

    if (selfPv > MONEY_EPS) {
      sk.buyers += 1;
      sk.pendingBuyerPv = round2(sk.pendingBuyerPv + selfPv);
      buyersFound.push({ id: item.id, selfPv });
      viewRows.set(item.id, {
        buyer_id: item.id,
        parent_id: item.parent,
        name: item.name,
        leg: item.leg,
        depth: item.level,
        self_pv: selfPv,
        amt: 0,
        amt_known: 0,
        _node: payload
      });
      if (isCurrentMonth) {
        stack.push({ type: 'amt', id: item.id, selfPv, leg: item.leg, level: item.level });
      }
    }

    kids.forEach((k, idx) => {
      if (k.groupPv > 0) {
        const leg = item.id === root ? (idx === 0 ? 'A' : idx === 1 ? 'B' : null) : item.leg;
        stack.push({ type: 'live', id: k.id, groupPv: k.groupPv, parent: item.id, level: item.level + 1, name: k.name, leg });
      }
    });
  };

  const processAmt = async (item) => {
    const info = await fetchDistributorInfo(session, item.id);
    sk.pendingBuyerPv = round2(Math.max(0, sk.pendingBuyerPv - item.selfPv));
    if (!info.ok) {
      sk.amountsFailed += 1;
      return;
    }
    sk.amountsDone += 1;
    sk.verifiedAmt = round2(sk.verifiedAmt + info.amt);
    if (info.pv > 0) ratios.push(info.amt / info.pv);

    const vr = viewRows.get(item.id);
    if (vr) {
      vr.amt = info.amt;
      vr.amt_known = 1;
      if (info.pv > 0) vr.self_pv = info.pv;
    }

    const nodeWrite = {
      ...((vr && vr._node) || { buyer_id: item.id }),
      repurchase_amt: info.amt,
      self_pv: info.pv > 0 ? info.pv : item.selfPv,
      current_pv: info.pv > 0 ? info.pv : item.selfPv,
      status: info.terminated ? 0 : 1,
      terminated: info.terminated ? 1 : 0
    };
    writer.add(() => writeNode(nodeWrite, item.id === root));
  };

  const worker = async () => {
    while (!aborted) {
      const item = stack.pop();
      if (!item) {
        if (inFlight === 0) return;
        await sleep(20);
        continue;
      }
      inFlight += 1;
      try {
        if (item.type === 'amt') await processAmt(item);
        else await processLive(item);
      } catch (err) {
        if (err.message === 'SESSION_EXPIRED') {
          aborted = true;
          state.error = 'SESSION_EXPIRED';
        } else if (item.type === 'live') {
          failed.push(item);
          sk.failedNodes += 1;
        } else {
          sk.amountsFailed += 1;
        }
      } finally {
        inFlight -= 1;
      }
    }
  };

  if (sk.macroPv > 0) {
    await Promise.all(Array.from({ length: Math.max(1, SKELETON_WORKERS) }, worker));
  }

  await writer.drain();
  refresh();

  sk.state = sk.residualPv <= MONEY_EPS && sk.amountsFailed === 0 ? 'VERIFIED' : 'BOUNDED';
  sk.finishedAt = new Date();

  if (activeView) {
    try {
      await activeView.replaceOwnerView({
        ownerId: root,
        monthKey,
        rows: [...viewRows.values()],
        deleteStale: sk.state === 'VERIFIED'
      });
      await activeView.saveSyncState({ ownerId: root, monthKey, sk });
    } catch (err) {
      console.warn(`[ACTIVE VIEW WARN] ${root}:`, err.message);
    }
  }

  state.skeletonDone = !aborted;
  if (io) {
    io.to(root).emit('tree:skeleton-complete', { ...sk, syncedCount: state.count });
  }
  return { aborted, skeleton: sk };
}

async function runStructureCrawl({ session, root, state, io }) {
  state.phase = 'STRUCTURE';
  const monthKey = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const queue = [{ distNo: root, depth: 0 }];
  const visited = new Set([root]);
  let aborted = false;

  const processNode = async (node) => {
    try {
      const children = await fetchDownline(session, node.distNo);
      for (let i = 0; i < children.length; i++) {
        const parsed = parseDownlineItem(children[i], i);
        if (!parsed || visited.has(parsed.id)) continue;
        visited.add(parsed.id);

        await persistParsedNode(parsed, node.distNo, node.depth + 1, root, monthKey);
        state.count++;
        queue.push({ distNo: parsed.id, depth: node.depth + 1 });
      }
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        aborted = true;
        state.error = 'SESSION_EXPIRED';
      }
    }
  };

  while (queue.length > 0 && !aborted) {
    const batch = queue.splice(0, CRAWL_CONCURRENCY);
    await Promise.all(batch.map(processNode));
    await sleep(randomBetween(NODE_DELAY_MIN_MS, NODE_DELAY_MAX_MS));
  }
  return { aborted };
}

function startBackgroundTreeCrawler({ session, buyerId, directLegs = [], month, year, io, forceFullCrawl = true }) {
  const root = String(buyerId);
  const existing = activeCrawls.get(root);
  if (existing && existing.running) return getCrawlStatus(root);

  const state = {
    running: true,
    count: directLegs.length,
    failedNodes: [],
    startedAt: new Date(),
    finishedAt: null,
    error: null,
    phase: 'STARTING',
    skeletonDone: false,
    skeleton: null
  };
  activeCrawls.set(root, state);

  setImmediate(async () => {
    let aborted = false;
    try {
      const r = await runSkeletonSync({ session, root, month, year, state, io });
      aborted = r.aborted;
    } catch (err) {
      state.error = err.message;
    }

    if (!aborted && forceFullCrawl) {
      try {
        await runStructureCrawl({ session, root, state, io });
      } catch (err) {
        state.error = err.message;
      }
    }

    state.running = false;
    state.finishedAt = new Date();
    state.phase = state.error ? 'ABORTED' : 'DONE';
  });

  return getCrawlStatus(root);
}

async function fetchChildrenOnDemand(rootId, parentId) {
  try {
    const { getSession } = require('./rcmSessionService');
    const session = getSession(rootId);
    if (!session) return { fetched: false, count: 0 };
    const monthKey = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;

    const children = await fetchDownline(session, parentId);
    let saved = 0;
    for (let i = 0; i < children.length; i++) {
      const parsed = parseDownlineItem(children[i], i);
      if (!parsed) continue;
      await persistParsedNode(parsed, parentId, 1, rootId, monthKey);
      saved++;
    }
    return { fetched: true, count: saved };
  } catch (err) {
    return { fetched: false, count: 0 };
  }
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
    error: state.error,
    phase: state.phase,
    skeletonDone: state.skeletonDone,
    skeleton: state.skeleton
  };
}

module.exports = {
  syncOverviewFast,
  startBackgroundTreeCrawler,
  getCrawlStatus,
  fetchChildrenOnDemand,
  fetchPvOnlyFull,
  fetchPvChildren,
  fetchDistributorInfo,
  syncSkeletonNow: async ({ session, buyerId, month, year, io }) => {
    const root = String(buyerId);
    const state = { count: 0, error: null, phase: 'SKELETON', skeletonDone: false, skeleton: null, failedNodes: [] };
    const r = await runSkeletonSync({ session, root, month, year, state, io });
    return { ...r.skeleton, aborted: r.aborted, error: state.error };
  }
};