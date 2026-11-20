'use strict';

const { Op } = require('sequelize');
const { InstagramAccount, InstagramReel } = require('../models');
const { fetchFullProfileReels } = require('./fullProfileReelsScraper');
const { logger } = require('../utils/logger');

const CONFIG = {
  SCRAPER_TIMEOUT_MS: 300000,
  INSERT_CHUNK_SIZE: 200,
  MAX_ERROR_LENGTH: 500,
  COOLDOWN_MS: 2500,
  MAX_QUEUE_SIZE: 50,
};

const syncState = {
  scraperEnabled: null,
  activeAccountId: null,
  activeUsername: null,
  status: 'idle', // 'idle' | 'syncing'
  queuedCount: 0,
  queuedItems: [],
  currentProgress: {
    scroll: 0,
    maxScrolls: 0,
    scrapedCount: 0,
    mode: null,
  },
  lastJob: null,
  lastUpdatedAt: null,
  recentLogs: [],
};

function isScraperEnabled() {
  const raw = String(process.env.SCRAPER_ENABLED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  // Default: allow unless explicitly disabled on Render
  return process.env.DISABLE_SCRAPER !== 'true';
}

function syncQueueMeta() {
  syncState.scraperEnabled = isScraperEnabled();
  syncState.queuedCount = jobQueue.length;
  syncState.queuedItems = jobQueue.map((j) => ({
    accountId: j.accountId,
    enqueuedAt: j.enqueuedAt,
  }));
}

function pushLog(level, message, meta = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  syncState.recentLogs = [entry, ...syncState.recentLogs].slice(0, 80);
  syncState.lastUpdatedAt = entry.timestamp;
}

function sanitizeHandle(raw) {
  if (!raw) return '';
  return String(raw).replace(/^@+/, '').trim();
}

function errorMessage(err) {
  const msg = err && err.message ? err.message : String(err || 'Unknown error');
  return msg.length > CONFIG.MAX_ERROR_LENGTH ? `${msg.slice(0, CONFIG.MAX_ERROR_LENGTH)}...` : msg;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pickModelFields(Model, data) {
  const attrs = Model && Model.rawAttributes ? Model.rawAttributes : null;
  if (!attrs) return data;
  const out = {};
  Object.keys(data).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) out[key] = data[key];
  });
  return out;
}

function extractShortcode(raw) {
  if (raw.shortcode) return String(raw.shortcode).trim();
  const url = raw.url || raw.permalink || '';
  const match = String(url).match(/instagram\.com\/(?:[\w.]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

function normalizeAndDedupe(rawItems, account, cleanUsername) {
  const map = new Map();
  for (const raw of rawItems || []) {
    if (!raw || typeof raw !== 'object') continue;
    const shortcode = extractShortcode(raw);
    if (!shortcode) continue;

    const existing = map.get(shortcode);
    const nextVideo =
      raw.videoUrl && /^https?:\/\//i.test(raw.videoUrl) && !/instagram\.com/i.test(raw.videoUrl)
        ? raw.videoUrl.trim()
        : null;
    const nextThumb =
      raw.thumbnailUrl && /^https?:\/\//i.test(raw.thumbnailUrl)
        ? raw.thumbnailUrl.trim()
        : `https://www.instagram.com/reel/${shortcode}/media/?size=l`;

    map.set(shortcode, {
      accountId: account.id,
      creatorHandle: cleanUsername,
      shortcode,
      url: raw.url || `https://www.instagram.com/reel/${shortcode}/`,
      title: String(raw.title || `Instagram Reel ${shortcode}`).trim().slice(0, 500),
      thumbnailUrl: nextThumb || existing?.thumbnailUrl || null,
      videoUrl: nextVideo || existing?.videoUrl || null,
      category: account.category || 'Motivation',
      isActive: true,
    });
  }
  return Array.from(map.values());
}

async function upsertReelsNoDuplicates(rows) {
  if (!rows || rows.length === 0) return { created: 0, updated: 0 };

  const shortcodes = rows.map((r) => r.shortcode);
  const existingRows = await InstagramReel.findAll({
    where: { shortcode: { [Op.in]: shortcodes } },
    attributes: ['id', 'shortcode', 'videoUrl', 'thumbnailUrl', 'title'],
  });
  const existingMap = new Map(existingRows.map((r) => [String(r.shortcode), r]));

  const toInsert = [];
  const toUpdate = [];

  for (const row of rows) {
    const existing = existingMap.get(row.shortcode);
    if (!existing) {
      toInsert.push(pickModelFields(InstagramReel, row));
    } else {
      const updates = {};
      if (row.videoUrl && !existing.videoUrl) updates.videoUrl = row.videoUrl;
      if (row.thumbnailUrl && row.thumbnailUrl !== existing.thumbnailUrl) {
        updates.thumbnailUrl = row.thumbnailUrl;
      }
      if (row.title && row.title !== existing.title) {
        updates.title = row.title;
      }
      if (Object.keys(updates).length > 0) {
        toUpdate.push({ existing, updates: pickModelFields(InstagramReel, updates) });
      }
    }
  }

  let created = 0;
  for (let i = 0; i < toInsert.length; i += CONFIG.INSERT_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CONFIG.INSERT_CHUNK_SIZE);
    const inserted = await InstagramReel.bulkCreate(chunk, { ignoreDuplicates: true });
    created += Array.isArray(inserted) ? inserted.length : chunk.length;
  }

  let updated = 0;
  for (const item of toUpdate) {
    await item.existing.update(item.updates);
    updated += 1;
  }

  return { created, updated };
}

async function countAccountReels(accountId, fallback = 0) {
  try {
    return await InstagramReel.count({ where: { accountId } });
  } catch (_) {
    return fallback;
  }
}

async function writeAccountState(account, { status, error, totalReels, scrapedCount = 0, newCount = 0 }) {
  const payload = pickModelFields(InstagramAccount, {
    lastSyncedAt: new Date(),
    lastSyncStatus: status,
    syncStatus: status,
    lastSyncError: error ? errorMessage(error) : null,
    reelsCount: totalReels,
    reelCount: totalReels,
    videoCount: totalReels,
    lastScrapedCount: scrapedCount,
    lastNewCount: newCount,
  });
  try {
    await account.update(payload);
  } catch (err) {
    logger.error(`[InstagramSyncService] Failed to update account ${account.id}: ${errorMessage(err)}`);
  }
}

// Strict global FIFO queue: concurrency = 1 across entire process to protect tablet RAM
const jobQueue = [];
let queueDraining = false;

function drainQueue() {
  if (queueDraining) return;
  queueDraining = true;

  (async () => {
    while (jobQueue.length > 0) {
      syncQueueMeta();
      const job = jobQueue.shift();
      syncQueueMeta();

      try {
        const result = await executeSingleSync(job.accountId, job.options);
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      }

      if (jobQueue.length > 0) {
        await new Promise((r) => setTimeout(r, CONFIG.COOLDOWN_MS));
      }
    }
  })()
    .catch((err) => {
      logger.error(`[InstagramSyncService] Queue loop error: ${errorMessage(err)}`);
    })
    .finally(() => {
      queueDraining = false;
      syncQueueMeta();
    });
}

function enqueueSyncJob(accountId, options = {}) {
  if (!isScraperEnabled()) {
    const disabledErr = new Error('Scraping is disabled on this server (SCRAPER_ENABLED is false). Use tablet worker.');
    disabledErr.code = 'SCRAPER_DISABLED';
    return Promise.reject(disabledErr);
  }

  const normalizedId = String(accountId);
  if (
    String(syncState.activeAccountId) === normalizedId ||
    jobQueue.some((item) => String(item.accountId) === normalizedId)
  ) {
    pushLog('info', `Account ${normalizedId} is already active or queued; skipping duplicate job.`, {
      accountId,
    });
  }

  if (jobQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
    return Promise.reject(new Error('Sync queue is full. Please wait for current jobs to finish.'));
  }

  return new Promise((resolve, reject) => {
    jobQueue.push({
      accountId,
      options,
      enqueuedAt: new Date().toISOString(),
      resolve,
      reject,
    });
    syncQueueMeta();
    pushLog('info', `Queued account ${accountId} for sequential scraping (queue size: ${jobQueue.length})`, {
      accountId,
      queuedCount: jobQueue.length,
    });
    drainQueue();
  });
}

async function executeSingleSync(accountId, options = {}) {
  const account = await InstagramAccount.findByPk(accountId);
  if (!account) {
    return { success: false, totalReels: 0, created: 0, updated: 0, scraped: 0 };
  }

  const cleanUsername = sanitizeHandle(options.username || account.username);
  if (!cleanUsername) {
    await writeAccountState(account, {
      status: 'FAILED',
      error: new Error('Missing username'),
      totalReels: await countAccountReels(account.id),
    });
    return { success: false, totalReels: 0, created: 0, updated: 0, scraped: 0 };
  }

  const currentDbCount = await countAccountReels(account.id);
  const mode = options.forceFull || currentDbCount === 0 ? 'full' : (options.mode || 'incremental');

  syncState.activeAccountId = account.id;
  syncState.activeUsername = cleanUsername;
  syncState.status = 'syncing';
  syncState.currentProgress = {
    scroll: 0,
    maxScrolls: 0,
    scrapedCount: 0,
    mode,
  };
  syncState.lastUpdatedAt = new Date().toISOString();

  pushLog('info', `Scraping @${cleanUsername} (${mode})...`, {
    accountId: account.id,
    username: cleanUsername,
    mode,
  });

  try {
    const rawReels = await withTimeout(
      fetchFullProfileReels(cleanUsername, {
        accountId: account.id,
        category: account.category || 'Motivation',
        mode,
        onProgress: (prog) => {
          syncState.currentProgress = {
            scroll: prog.scroll || 0,
            maxScrolls: prog.maxScrolls || 0,
            scrapedCount: prog.scrapedCount || 0,
            mode: prog.mode || mode,
          };
          pushLog(
            'progress',
            `@${cleanUsername} Scroll ${prog.scroll}/${prog.maxScrolls}: ${prog.scrapedCount} reels found`,
            { accountId: account.id, username: cleanUsername, ...prog }
          );
        },
      }),
      CONFIG.SCRAPER_TIMEOUT_MS,
      'fetchFullProfileReels'
    );

    const rows = normalizeAndDedupe(rawReels, account, cleanUsername);
    const { created, updated } = await upsertReelsNoDuplicates(rows);
    const totalReels = await countAccountReels(account.id, rows.length);

    await writeAccountState(account, {
      status: 'SUCCESS',
      error: null,
      totalReels,
      scrapedCount: rows.length,
      newCount: created,
    });

    if (typeof global.invalidateFeedCandidateCache === 'function') {
      global.invalidateFeedCandidateCache();
    }

    const summary = {
      success: true,
      accountId: account.id,
      username: cleanUsername,
      mode,
      scraped: rows.length,
      created,
      updated,
      totalReels,
      error: null,
      completedAt: new Date().toISOString(),
    };
    syncState.lastJob = summary;

    pushLog(
      'success',
      `Completed @${cleanUsername}: scraped ${rows.length}, +${created} new, updated ${updated}, DB total ${totalReels}`,
      summary
    );

    return { success: true, totalReels, created, updated, scraped: rows.length };
  } catch (err) {
    const msg = errorMessage(err);
    const dbTotal = await countAccountReels(account.id);
    await writeAccountState(account, {
      status: 'FAILED',
      error: err,
      totalReels: dbTotal,
    });

    const summary = {
      success: false,
      accountId: account.id,
      username: cleanUsername,
      mode,
      scraped: syncState.currentProgress.scrapedCount || 0,
      created: 0,
      updated: 0,
      totalReels: dbTotal,
      error: msg,
      completedAt: new Date().toISOString(),
    };
    syncState.lastJob = summary;

    pushLog('error', `Failed @${cleanUsername}: ${msg}`, summary);
    return { success: false, totalReels: dbTotal, created: 0, updated: 0, scraped: 0, error: msg };
  } finally {
    syncState.activeAccountId = null;
    syncState.activeUsername = null;
    syncState.status = 'idle';
    syncState.currentProgress = {
      scroll: 0,
      maxScrolls: 0,
      scrapedCount: 0,
      mode: null,
    };
    syncQueueMeta();
  }
}

function syncAccountDetailed(accountId, options = {}) {
  return enqueueSyncJob(accountId, options);
}

async function syncAccount(accountId, options = {}) {
  const res = await syncAccountDetailed(accountId, options);
  return res.totalReels;
}

let batchRunning = false;

async function syncAllAccounts(options = {}) {
  if (!isScraperEnabled()) {
    const disabledErr = new Error('Scraping is disabled on this server (SCRAPER_ENABLED is false). Use tablet worker.');
    disabledErr.code = 'SCRAPER_DISABLED';
    throw disabledErr;
  }

  if (batchRunning) return null;
  batchRunning = true;

  try {
    const accounts = await InstagramAccount.findAll({
      where: { isActive: true },
      attributes: ['id', 'username'],
    });

    let succeeded = 0;
    let failed = 0;
    let totalReels = 0;

    for (const acc of accounts) {
      const res = await syncAccountDetailed(acc.id, options);
      if (res && res.success) succeeded += 1;
      else failed += 1;
      totalReels += res ? res.totalReels : 0;
    }

    return { total: accounts.length, succeeded, failed, totalReels };
  } finally {
    batchRunning = false;
  }
}

function getSyncActivity() {
  syncQueueMeta();
  return {
    ...syncState,
    currentProgress: { ...syncState.currentProgress },
    queuedItems: [...syncState.queuedItems],
    lastJob: syncState.lastJob ? { ...syncState.lastJob } : null,
    recentLogs: [...syncState.recentLogs],
  };
}

module.exports = {
  syncAccount,
  syncAccountDetailed,
  syncAllAccounts,
  getSyncActivity,
  isScraperEnabled,
  sanitizeHandle,
};