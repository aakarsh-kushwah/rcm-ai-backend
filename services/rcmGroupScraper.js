'use strict';

const axios = require('axios');
let models = {};
try {
  models = require('../models');
} catch (e) {
  console.warn('[MODEL LOAD NOTICE]:', e.message);
}

const { DownlineNode, MemberMonthlySnapshot } = models;
const ECOM_BASE = 'https://ecomapi.rcmworld.com/api';

const parseNum = (v) => parseFloat(String(v || '0').replace(/,/g, '').trim()) || 0;

/**
 * Helper to execute HTTP requests via session.client or axios safely
 */
async function safeGet(session, url) {
  try {
    const headers = {
      'Authorization': session?.client?.defaults?.headers?.common['Authorization'] || '',
      'Cookie': session?.client?.defaults?.headers?.common['Cookie'] || '',
      'Origin': 'https://www.rcmworld.com',
      'Referer': 'https://www.rcmworld.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    if (session?.client) {
      return await session.client.get(url, { headers, timeout: 8000, validateStatus: () => true });
    }
    return await axios.get(url, { headers, timeout: 8000, validateStatus: () => true });
  } catch (err) {
    return { status: 500, data: null, error: err.message };
  }
}

/**
 * 1. Stage 1: Fast Sync with Automatic Month Fallback (Handles 1st of month 404 gracefully)
 */
async function syncOverviewFast({ session, buyerId, month, year }) {
  const now = new Date();
  const requestedMonth = month || (now.getMonth() + 1);
  const currentYear = year || now.getFullYear();

  // Previous month calculation (e.g. Month 11 -> Month 10)
  const prevDate = new Date(currentYear, requestedMonth - 2, 1);
  const prevMonth = prevDate.getMonth() + 1;
  const prevYear = prevDate.getFullYear();

  console.log(`[FAST SYNC] Fetching root profile for ${buyerId} (Attempting Month: ${requestedMonth}, Year: ${currentYear})`);

  let activeMonth = requestedMonth;
  let activeYear = currentYear;
  let profileData = null;

  // Step A1: Try Requested Month Profile
  let profileUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume/profile?distno=${buyerId}&month=${requestedMonth}&year=${currentYear}`;
  let profileRes = await safeGet(session, profileUrl);

  if (profileRes.status === 200 && profileRes.data?.data) {
    profileData = profileRes.data.data;
  } else {
    // Step A2: Fallback to Previous Month (October) if current month is 404/Empty
    console.log(`[FAST SYNC] Month ${requestedMonth} returned ${profileRes.status}. Falling back to Month ${prevMonth}/${prevYear}...`);
    activeMonth = prevMonth;
    activeYear = prevYear;
    profileUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume/profile?distno=${buyerId}&month=${prevMonth}&year=${prevYear}`;
    profileRes = await safeGet(session, profileUrl);
    profileData = profileRes.data?.data || {};
  }

  // Step B: Direct Legs Fetch
  const legsUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume/1?distno=${buyerId}&month=${activeMonth}&year=${activeYear}`;
  const legsRes = await safeGet(session, legsUrl);
  const directLegsRaw = (legsRes.status === 200 && Array.isArray(legsRes.data?.data)) ? legsRes.data.data : [];

  if (directLegsRaw.length === 0) {
    console.log(`[FAST SYNC] Month ${activeMonth} returned 0 legs. Fetching downline legs from Month ${prevMonth}/${prevYear}...`);
    const fallbackLegsUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume/1?distno=${buyerId}&month=${prevMonth}&year=${prevYear}`;
    const fallbackRes = await safeGet(session, fallbackLegsUrl);
    if (fallbackRes.status === 200 && Array.isArray(fallbackRes.data?.data) && fallbackRes.data.data.length > 0) {
      directLegsRaw = fallbackRes.data.data;
      activeMonth = prevMonth;
      activeYear = prevYear;
    }
  }

  const totalPv = parseNum(profileData.tot_pv || profileData.purchase_volume);
  const selfPv = parseNum(profileData.self_pv);
  const associateName = profileData.dist_name || profileData.name || `Associate #${buyerId}`;
  const pinLevel = profileData.curr_pin || profileData.pin_level || 'DIRECT SELLER';

  const directLegs = directLegsRaw.map((leg) => {
    const isTerminated = Boolean(leg.is_terminated || /terminated/i.test(leg.dist_name || ''));
    const legPv = parseNum(leg.tot_pv || leg.purchase_volume);
    return {
      distno: leg.distno,
      name: (leg.dist_name || '').replace(/terminated\s*-\s*/i, '').trim(),
      pv: legPv,
      status: isTerminated ? 'TERMINATED' : (legPv > 0 ? 'ACTIVE' : 'INACTIVE')
    };
  });

  // TiDB Upsert
  if (MemberMonthlySnapshot && MemberMonthlySnapshot.upsert) {
    const monthKey = `${activeYear}${String(activeMonth).padStart(2, '0')}`;
    await MemberMonthlySnapshot.upsert({
      buyer_id: String(buyerId),
      month_key: monthKey,
      month: activeMonth,
      year: activeYear,
      associate_name: associateName,
      pin_level: pinLevel,
      total_pv: totalPv,
      self_pv: selfPv,
      last_synced_at: new Date()
    }).catch(err => console.warn('[DB SNAPSHOT WARN]:', err.message));
  }

  if (DownlineNode && DownlineNode.upsert) {
    for (const leg of directLegs) {
      await DownlineNode.upsert({
        root_buyer_id: String(buyerId),
        parent_buyer_id: String(buyerId),
        buyer_id: String(leg.distno),
        associate_name: leg.name,
        purchase_volume: leg.pv,
        status: leg.status
      }).catch(() => null);
    }
  }

  return {
    associateName,
    pinLevel,
    totalPv,
    selfPv,
    activeMonth,
    activeYear,
    directLegs
  };
}

/**
 * 2. Stage 2: Background Parallel Tree Ingestion Worker
 */
function startBackgroundTreeCrawler({ session, buyerId, directLegs, month, year, io }) {
  setImmediate(async () => {
    const currentMonth = month || 10;
    const currentYear = year || 2026;

    console.log(`[TREE CRAWLER] Starting recursive indexing for Associate: ${buyerId} (Month: ${currentMonth})`);
    const queue = [...directLegs.map(l => ({ distno: l.distno, parentId: buyerId }))];
    const visited = new Set([String(buyerId)]);
    let syncedCount = directLegs.length;

    const CONCURRENCY = 5;

    while (queue.length > 0) {
      const batch = queue.splice(0, CONCURRENCY);

      await Promise.all(
        batch.map(async (node) => {
          const safeId = String(node.distno);
          if (visited.has(safeId)) return;
          visited.add(safeId);

          try {
            const url = `${ECOM_BASE}/user/business-info/your-purchase-volume/1?distno=${safeId}&month=${currentMonth}&year=${currentYear}`;
            const res = await safeGet(session, url);
            const children = (res.status === 200 && Array.isArray(res.data?.data)) ? res.data.data : [];

            for (const child of children) {
              const childDistNo = String(child.distno);
              const childPv = parseNum(child.tot_pv || child.purchase_volume);
              const isTerminated = Boolean(child.is_terminated || /terminated/i.test(child.dist_name || ''));
              const childName = (child.dist_name || '').replace(/terminated\s*-\s*/i, '').trim();

              if (DownlineNode && DownlineNode.upsert) {
                await DownlineNode.upsert({
                  root_buyer_id: String(buyerId),
                  parent_buyer_id: safeId,
                  buyer_id: childDistNo,
                  associate_name: childName,
                  purchase_volume: childPv,
                  status: isTerminated ? 'TERMINATED' : (childPv > 0 ? 'ACTIVE' : 'INACTIVE')
                }).catch(() => null);
              }

              syncedCount++;
              if (!visited.has(childDistNo)) {
                queue.push({ distno: childDistNo, parentId: safeId });
              }
            }

            if (io) {
              io.to(String(buyerId)).emit('tree:sync-progress', { syncedCount, status: 'IN_PROGRESS' });
            }
          } catch (err) {
            console.warn(`[TREE CRAWLER WARN] Node ${safeId}:`, err.message);
          }
        })
      );
    }

    console.log(`[TREE CRAWLER COMPLETE] Total ${syncedCount} nodes indexed in TiDB for: ${buyerId}`);
    if (io) {
      io.to(String(buyerId)).emit('tree:sync-complete', { totalMembers: syncedCount });
    }
  });
}

/**
 * Aliases and Wrappers for Controller Compatibility
 */
async function fetchMacroPvAndProfile(session, buyerId) {
  const overview = await syncOverviewFast({ session, buyerId });
  return {
    identity: {
      buyer_id: buyerId,
      name: overview.associateName,
      highest_pin: overview.pinLevel
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
    month: macroInfo?.activeMonth || 10,
    year: macroInfo?.activeYear || 2026
  });
}

function getCrawlStatus(rootId) {
  return { running: false, count: 0 };
}

async function fetchChildrenOnDemand(rootId, parentId) {
  return { fetched: true, count: 0 };
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