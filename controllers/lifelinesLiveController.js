'use strict';

/**
 * controllers/lifelinesLiveController.js
 * Exposes live accurate counters:
 *  - total_members, terminated_members, inactive_members, active_buyers
 *  - total_sale (Rs.) and group PV
 *  - PV buckets and leg splits
 */

const activeView = require('../services/rcmActiveView');
const rcmGroupScraper = require('../services/rcmGroupScraper');
const { getSession } = require('../services/rcmSessionService');

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round2 = (v) => Math.round(num(v) * 100) / 100;
const truthy = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
const monthKeyOf = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;

function resolveRoot(req, res, suppliedRoot) {
  const tokenRoot = req.lifelinesRoot ? Number(req.lifelinesRoot) : null;
  const supplied = num(suppliedRoot, 0);
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

const refreshing = new Map();

function isRefreshing(rootId) {
  const key = String(rootId);
  if (refreshing.has(key)) return true;
  const crawl = rcmGroupScraper.getCrawlStatus(key);
  return Boolean(crawl && crawl.running && crawl.phase === 'SKELETON');
}

function startRefresh(rootId, session) {
  const key = String(rootId);
  if (isRefreshing(key)) return true;
  refreshing.set(key, Date.now());
  rcmGroupScraper
    .syncSkeletonNow({ session, buyerId: key })
    .catch((err) => console.warn(`[LIVE REFRESH WARN] ${key}:`, err.message))
    .finally(() => refreshing.delete(key));
  return true;
}

function shapeSummary(summary, live) {
  if (!summary.exists) {
    return {
      month: summary.monthKey,
      synced: false,
      state: 'NOT_SYNCED',
      status: live.refreshing ? 'UPDATING' : 'WAITING',
      totalSale: { exact: false, amt: 0, verifiedAmt: 0, estLow: 0, estHigh: 0 },
      counts: { totalMembers: 0, terminatedMembers: 0, inactiveMembers: 0, activeBuyers: 0 },
      buyers: 0,
      legs: [],
      live
    };
  }

  const exact = summary.state === 'VERIFIED' && summary.amtComplete;
  let status = 'CACHED';
  if (live.refreshing) status = 'UPDATING';
  else if (summary.state === 'VERIFIED') status = 'LIVE';

  return {
    month: summary.monthKey,
    synced: true,
    state: summary.state,
    status,
    verified: summary.state === 'VERIFIED',
    verifiedAt: summary.verifiedAt,
    macroPv: summary.macroPv,
    processedPv: summary.processedPv,
    coveragePct: summary.coveragePct,
    totalSale: {
      exact,
      amt: exact ? summary.totals.amt : (summary.estLow || summary.totals.amt),
      verifiedAmt: summary.totals.amt,
      estLow: summary.estLow || summary.totals.amt,
      estHigh: summary.estHigh || summary.totals.amt
    },
    counts: summary.counts,
    buyers: summary.totals.buyers,
    buyersSelfPv: summary.totals.selfPv,
    legs: summary.legs,
    live
  };
}

exports.getLiveSummary = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const now = new Date();
    const monthKey = monthKeyOf(now);
    const summary = await activeView.getSummary(rootId, monthKey);

    const live = {
      checkRequested: truthy(req.query.check),
      checked: false,
      sessionActive: false,
      refreshing: isRefreshing(rootId)
    };

    if (live.checkRequested) {
      const session = getSession(rootId);
      if (session) {
        live.sessionActive = true;
        live.refreshing = startRefresh(rootId, session);
      }
    }

    return res.status(200).json({ success: true, data: shapeSummary(summary, live) });
  } catch (error) {
    console.error('Error in getLiveSummary:', error.message);
    return res.status(500).json({ success: false, message: 'Could not load live summary.' });
  }
};

exports.getPvBuckets = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const requestedMonth = String(req.query.monthKey || '').trim();
    const monthKey = /^\d{6}$/.test(requestedMonth) ? requestedMonth : monthKeyOf(new Date());

    const result = await activeView.getBuckets({
      ownerId: rootId,
      monthKey,
      bucket: req.query.bucket || null,
      limit: num(req.query.limit, 200),
      offset: num(req.query.offset, 0)
    });

    return res.status(200).json({ success: true, data: { month: monthKey, ...result } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not load PV buckets.' });
  }
};

exports.postLiveRefresh = async (req, res) => {
  try {
    const rootId = resolveRoot(req, res, req.body?.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const session = getSession(rootId);
    if (!session) {
      return res.status(409).json({ success: false, message: 'Please log in again to refresh.' });
    }
    const wasRunning = isRefreshing(rootId);
    startRefresh(rootId, session);
    return res.status(202).json({ success: true, started: !wasRunning, refreshing: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not start refresh.' });
  }
};