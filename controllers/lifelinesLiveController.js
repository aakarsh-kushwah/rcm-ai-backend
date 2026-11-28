'use strict';

/**
 * controllers/lifelinesLiveController.js
 * Exposes live accurate counters:
 *  - total_members, terminated_members, inactive_members, active_buyers
 *  - total_sale (Rs.) and group PV
 *  - PV buckets and leg splits (A, B, C, ...)
 *  - Smart live-check refresh (avoids redundant crawls when PV is unchanged & verified)
 */

const activeView = require('../services/rcmActiveView');
const rcmGroupScraper = require('../services/rcmGroupScraper');
const { getSession } = require('../services/rcmSessionService');

let treeSearchHelper = null;
try {
  treeSearchHelper = require('../utils/treeSearchHelper');
} catch (e) {
  // Optional cache invalidator
}

const MONEY_EPS = 0.05;
const REFRESH_LOCK_TTL_MS = 10 * 60 * 1000;

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const truthy = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
const monthKeyOf = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;

function invalidateTreeSafe(rootId) {
  try {
    if (treeSearchHelper && typeof treeSearchHelper.invalidateTree === 'function') {
      treeSearchHelper.invalidateTree(String(rootId));
    }
  } catch (e) {
    // Best-effort cache invalidation
  }
}

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
  const startedAt = refreshing.get(key);
  if (startedAt) {
    if (Date.now() - startedAt < REFRESH_LOCK_TTL_MS) return true;
    refreshing.delete(key);
  }
  const crawl = rcmGroupScraper.getCrawlStatus(key);
  return Boolean(crawl && crawl.running);
}

function startRefresh(rootId, session, { knownMacroPv = 0, includeStructure = true, forceFullCrawl = false } = {}) {
  const key = String(rootId);
  if (isRefreshing(key)) return true;
  refreshing.set(key, Date.now());

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  if (includeStructure && typeof rcmGroupScraper.startBackgroundTreeCrawler === 'function') {
    try {
      rcmGroupScraper.startBackgroundTreeCrawler({
        session,
        buyerId: key,
        month,
        year,
        knownMacroPv,
        forceFullCrawl: forceFullCrawl ? true : null,
        onComplete: ({ isComplete }) => {
          invalidateTreeSafe(key);
          if (isComplete) refreshing.delete(key);
        }
      });
      return true;
    } catch (err) {
      console.warn(`[LIVE CRAWLER START WARN] ${key}:`, err.message);
      refreshing.delete(key);
    }
  }

  rcmGroupScraper
    .syncSkeletonNow({ session, buyerId: key, month, year, knownMacroPv })
    .catch((err) => console.warn(`[LIVE REFRESH WARN] ${key}:`, err.message))
    .finally(() => {
      invalidateTreeSafe(key);
      refreshing.delete(key);
    });
  return true;
}

function shapeSummary(summary, live) {
  if (!summary.exists) {
    return {
      month: summary.monthKey,
      synced: false,
      state: 'NOT_SYNCED',
      status: live.refreshing ? 'UPDATING' : 'WAITING',
      macroPv: live.livePv || 0,
      totalSale: { exact: false, amt: 0, verifiedAmt: 0, estLow: 0, estHigh: 0 },
      counts: { totalMembers: 0, terminatedMembers: 0, inactiveMembers: 0, activeBuyers: 0 },
      buyers: 0,
      legs: [],
      live
    };
  }

  const exact = summary.state === 'VERIFIED' && summary.amtComplete && !live.pvChanged;
  let status = 'CACHED';
  if (live.refreshing) status = 'UPDATING';
  else if (summary.state === 'VERIFIED' && !live.pvChanged) status = 'LIVE';

  const effectiveMacroPv = live.livePv > 0
    ? Math.max(num(summary.macroPv, 0), live.livePv)
    : num(summary.macroPv, 0);

  return {
    month: summary.monthKey,
    synced: true,
    state: live.pvChanged ? 'BOUNDED' : summary.state,
    status,
    verified: summary.state === 'VERIFIED' && !live.pvChanged,
    verifiedAt: summary.verifiedAt,
    updatedAt: summary.updatedAt,
    macroPv: effectiveMacroPv,
    processedPv: summary.processedPv,
    residualPv: live.pvChanged
      ? Math.max(0, Math.round((effectiveMacroPv - num(summary.processedPv, 0)) * 100) / 100)
      : summary.residualPv,
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
    res.set('Cache-Control', 'no-store');
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const now = new Date();
    const currentMonthKey = monthKeyOf(now);
    const requestedMonth = String(req.query.monthKey || req.query.month_key || '').trim();
    const monthKey = /^\d{6}$/.test(requestedMonth) ? requestedMonth : currentMonthKey;
    const isCurrentMonth = monthKey === currentMonthKey;
    const force = truthy(req.query.force);

    const summary = await activeView.getSummary(rootId, monthKey);

    const live = {
      checkRequested: isCurrentMonth && (truthy(req.query.check) || force),
      checked: false,
      sessionActive: false,
      sessionExpired: false,
      pvChanged: false,
      hasGap: false,
      livePv: 0,
      liveSelfPv: 0,
      refreshing: isCurrentMonth ? isRefreshing(rootId) : false
    };

    if (live.checkRequested) {
      live.checked = true;
      const session = await getSession(rootId);
      if (!session) {
        live.sessionExpired = true;
      } else {
        live.sessionActive = true;
        const m = now.getMonth() + 1;
        const y = now.getFullYear();
        const pvSnap = typeof rcmGroupScraper.fetchPvOnlyFull === 'function'
          ? await rcmGroupScraper.fetchPvOnlyFull(session, rootId, m, y)
          : { ok: false };

        if (pvSnap?.error === 'SESSION_EXPIRED') {
          live.sessionActive = false;
          live.sessionExpired = true;
        } else {
          if (pvSnap?.ok) {
            live.livePv = num(pvSnap.groupPv, 0);
            live.liveSelfPv = num(pvSnap.selfPv, 0);
            live.pvChanged = Math.abs(live.livePv - num(summary.macroPv, 0)) > MONEY_EPS;
          }

          live.hasGap =
            !summary.exists ||
            summary.state !== 'VERIFIED' ||
            !summary.amtComplete ||
            (pvSnap?.ok && Math.abs(live.livePv - num(summary.processedPv, 0)) > MONEY_EPS);

          if (force || live.pvChanged || live.hasGap) {
            live.refreshing = startRefresh(rootId, session, {
              knownMacroPv: live.livePv || num(summary.macroPv, 0),
              includeStructure: true,
              forceFullCrawl: false
            });
          }
        }
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
    res.set('Cache-Control', 'no-store');
    const rootId = resolveRoot(req, res, req.params.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const requestedMonth = String(req.query.monthKey || req.query.month_key || '').trim();
    const monthKey = /^\d{6}$/.test(requestedMonth) ? requestedMonth : monthKeyOf(new Date());
    const legRaw = String(req.query.leg || '').trim().toUpperCase().replace(/^LEG\s*/, '');

    const result = await activeView.getBuckets({
      ownerId: rootId,
      monthKey,
      leg: legRaw || null,
      bucket: req.query.bucket || null,
      minPv: req.query.minPv ?? null,
      maxPv: req.query.maxPv ?? null,
      limit: num(req.query.limit, 200),
      offset: num(req.query.offset, 0)
    });

    return res.status(200).json({ success: true, data: { month: monthKey, ...result } });
  } catch (error) {
    console.error('Error in getPvBuckets:', error.message);
    return res.status(500).json({ success: false, message: 'Could not load PV buckets.' });
  }
};

exports.postLiveRefresh = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const rootId = resolveRoot(req, res, req.body?.buyerId || req.query.buyerId);
    if (!rootId) return undefined;

    const session = await getSession(rootId);
    if (!session) {
      return res.status(409).json({
        success: false,
        sessionExpired: true,
        message: 'Please log in again to refresh.'
      });
    }

    const forceFullCrawl = truthy(req.body?.forceFullCrawl || req.query.forceFullCrawl);
    const wasRunning = isRefreshing(rootId);
    startRefresh(rootId, session, {
      includeStructure: true,
      forceFullCrawl
    });

    return res.status(202).json({
      success: true,
      started: !wasRunning,
      refreshing: true
    });
  } catch (error) {
    console.error('Error in postLiveRefresh:', error.message);
    return res.status(500).json({ success: false, message: 'Could not start refresh.' });
  }
};