'use strict';

const { Op } = require('sequelize');
const InstagramAccount = require('../models/InstagramAccount');
const InstagramReel = require('../models/InstagramReel');
const { fetchFullProfileReels } = require('./fullProfileReelsScraper');
const { fetchProfileReels } = require('./instagramScraper');
const { logger } = require('../utils/logger');

/* ---------------------------------------------------------------------------
 * Instagram Sync Service
 *
 * Pipeline for every account:
 *   1. sanitize the handle                      (leading @ and whitespace removed)
 *   2. fetchFullProfileReels(handle)            (primary scraper)
 *   3. throws OR 0 reels -> fetchProfileReels   (fallback scraper)
 *   4. normalize + de-duplicate shortcodes
 *   5. ONE lookup query + bulk insert + targeted updates (no N+1 queries)
 *   6. count the TRUE number of reels in the database
 *   7. write reelsCount / reelCount / videoCount / lastSyncStatus on the account
 *
 * Counts always come from the database, never from the scraper payload, so the
 * admin panel can never show "0 reels" for an account that has reels stored.
 * ------------------------------------------------------------------------- */

const CONFIG = {
  SCRAPER_TIMEOUT_MS: 120000, // a hung scraper can never block the batch
  ACCOUNT_CONCURRENCY: 3, // accounts synced in parallel during syncAllAccounts
  INSERT_CHUNK_SIZE: 200, // rows per bulk INSERT
  UPDATE_CONCURRENCY: 5, // parallel UPDATEs for changed rows
  MAX_ERROR_LENGTH: 500,
};

/* ---------- helpers ---------- */

/** Removes leading '@' characters and surrounding whitespace. */
function sanitizeHandle(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).replace(/^@+/, '').trim();
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Only real media URLs are stored. Instagram / YouTube page URLs are not playable in a <video>. */
function toMediaUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (/^https?:\/\/(?:[\w-]+\.)?(?:instagram\.com|youtube\.com|youtu\.be)\//i.test(url)) return null;
  return url;
}

function toImageUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

function firstDefined(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
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

/** Runs async work over a list with a fixed number of parallel workers. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Keeps only attributes that exist on the model, so schema differences never crash a write. */
function pickModelFields(Model, data) {
  const attrs = Model && Model.rawAttributes ? Model.rawAttributes : null;
  if (!attrs) return data;
  const out = {};
  Object.keys(data).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) out[key] = data[key];
  });
  return out;
}

/** Normalizes any scraper payload shape into a plain array of reel items. */
function extractReelArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const keys = ['reels', 'items', 'data', 'results', 'videos'];
    for (let i = 0; i < keys.length; i += 1) {
      if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
  }
  return [];
}

/* ---------- scraping ---------- */

async function runScraper(name, scraper, cleanUsername, account) {
  if (typeof scraper !== 'function') {
    return { name, reels: [], error: new Error(`${name} is not available`), attempted: false };
  }
  try {
    const data = await withTimeout(
      scraper(cleanUsername, { accountId: account.id, category: account.category || 'General' }),
      CONFIG.SCRAPER_TIMEOUT_MS,
      name
    );
    return { name, reels: extractReelArray(data), error: null, attempted: true };
  } catch (err) {
    return { name, reels: [], error: err, attempted: true };
  }
}

/**
 * Primary scraper first. If it throws or returns 0 reels, the fallback scraper runs automatically.
 */
async function scrapeWithFallback(cleanUsername, account) {
  const attempts = [];

  const primary = await runScraper('fetchFullProfileReels', fetchFullProfileReels, cleanUsername, account);
  attempts.push(primary);
  if (primary.error) {
    logger.warn(`[InstagramSyncService] fetchFullProfileReels failed for @${cleanUsername}: ${errorMessage(primary.error)}`);
  }
  if (primary.reels.length > 0) return { reels: primary.reels, source: primary.name, attempts };

  logger.info(`[InstagramSyncService] Primary scraper returned 0 reels for @${cleanUsername}. Trying fetchProfileReels fallback...`);
  const fallback = await runScraper('fetchProfileReels', fetchProfileReels, cleanUsername, account);
  attempts.push(fallback);
  if (fallback.error) {
    logger.warn(`[InstagramSyncService] fetchProfileReels failed for @${cleanUsername}: ${errorMessage(fallback.error)}`);
  }
  return { reels: fallback.reels, source: fallback.reels.length > 0 ? fallback.name : null, attempts };
}

/* ---------- normalization ---------- */

function extractShortcode(raw) {
  const direct = firstDefined(raw.shortcode, raw.code, raw.shortCode);
  if (direct) return String(direct).trim();
  const url = firstDefined(raw.url, raw.permalink, raw.link);
  if (typeof url === 'string') {
    const match = url.match(/instagram\.com\/(?:[\w.]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    if (match) return match[1];
  }
  return raw.id !== undefined && raw.id !== null ? String(raw.id).trim() : '';
}

/** Converts one scraped item into a database row. Returns null if it has no usable shortcode. */
function normalizeReel(raw, account, cleanUsername) {
  if (!raw || typeof raw !== 'object') return null;
  const shortcode = extractShortcode(raw);
  if (!shortcode) return null;

  const caption = String(firstDefined(raw.caption, raw.title, raw.description, '') || '');
  return {
    accountId: account.id,
    creatorHandle: cleanUsername,
    shortcode,
    caption,
    title: String(firstDefined(raw.title, raw.caption, '') || ''),
    videoUrl: toMediaUrl(firstDefined(raw.videoUrl, raw.directVideo, raw.mediaUrl, raw.video_url)),
    thumbnailUrl: toImageUrl(firstDefined(raw.thumbnailUrl, raw.displayUrl, raw.thumb, raw.thumbnail, raw.thumbnail_url)),
    likesCount: toCount(firstDefined(raw.likesCount, raw.likeCount, raw.likes)),
    commentsCount: toCount(firstDefined(raw.commentsCount, raw.commentCount, raw.comments)),
    viewCount: toCount(firstDefined(raw.viewCount, raw.playCount, raw.videoPlayCount, raw.views)),
    duration: Number(firstDefined(raw.duration, raw.videoDuration, 0)) || 0,
    publishedAt: toDate(firstDefined(raw.publishedAt, raw.takenAt, raw.timestamp, raw.createdAt)) || new Date(),
    isAvailable: true,
  };
}

/** De-duplicates by shortcode inside one batch. Later items win, but never overwrite a value with null. */
function normalizeAndDedupe(rawItems, account, cleanUsername) {
  const byCode = new Map();
  rawItems.forEach((raw) => {
    const row = normalizeReel(raw, account, cleanUsername);
    if (!row) return;
    const previous = byCode.get(row.shortcode);
    if (!previous) {
      byCode.set(row.shortcode, row);
      return;
    }
    const merged = { ...previous };
    Object.keys(row).forEach((key) => {
      if (row[key] !== null && row[key] !== '' && row[key] !== 0) merged[key] = row[key];
    });
    byCode.set(row.shortcode, merged);
  });
  return Array.from(byCode.values());
}

/* ---------- database upsert ---------- */

/** Fields refreshed on every sync. videoUrl is refreshed because Instagram CDN links expire. */
const REFRESH_FIELDS = ['videoUrl', 'thumbnailUrl', 'caption', 'title', 'likesCount', 'commentsCount', 'viewCount', 'duration'];

function buildChanges(existing, row) {
  const changes = {};
  REFRESH_FIELDS.forEach((field) => {
    const next = row[field];
    if (next === null || next === undefined || next === '' || next === 0) return; // never wipe good data
    if (existing[field] !== next) changes[field] = next;
  });
  if (existing.accountId === null || existing.accountId === undefined) changes.accountId = row.accountId;
  if (existing.isAvailable === false) changes.isAvailable = true;
  return changes;
}

/**
 * One SELECT for existing rows, one bulk INSERT per chunk for new rows,
 * and UPDATEs only for rows whose data actually changed.
 */
async function upsertReels(rows) {
  if (rows.length === 0) return { created: 0, updated: 0 };

  const codes = rows.map((r) => r.shortcode);
  const existingRows = await InstagramReel.findAll({ where: { shortcode: { [Op.in]: codes } } });
  const existingByCode = new Map(existingRows.map((e) => [String(e.shortcode), e]));

  const toInsert = [];
  const toUpdate = [];
  rows.forEach((row) => {
    const existing = existingByCode.get(row.shortcode);
    if (!existing) {
      toInsert.push(pickModelFields(InstagramReel, row));
      return;
    }
    const changes = buildChanges(existing, row);
    if (Object.keys(changes).length > 0) toUpdate.push({ existing, changes: pickModelFields(InstagramReel, changes) });
  });

  let created = 0;
  for (let i = 0; i < toInsert.length; i += CONFIG.INSERT_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CONFIG.INSERT_CHUNK_SIZE);
    try {
      const inserted = await InstagramReel.bulkCreate(chunk, { ignoreDuplicates: true });
      created += Array.isArray(inserted) ? inserted.length : chunk.length;
    } catch (bulkErr) {
      // A bad row must not lose the whole chunk: fall back to row-by-row inserts.
      logger.warn(`[InstagramSyncService] Bulk insert failed (${errorMessage(bulkErr)}). Retrying row by row.`);
      for (const row of chunk) {
        try {
          await InstagramReel.create(row);
          created += 1;
        } catch (rowErr) {
          logger.warn(`[InstagramSyncService] Skipped reel ${row.shortcode}: ${errorMessage(rowErr)}`);
        }
      }
    }
  }

  let updated = 0;
  await mapWithConcurrency(toUpdate, CONFIG.UPDATE_CONCURRENCY, async ({ existing, changes }) => {
    try {
      await existing.update(changes);
      updated += 1;
    } catch (updateErr) {
      logger.warn(`[InstagramSyncService] Failed to update reel ${existing.shortcode}: ${errorMessage(updateErr)}`);
    }
  });

  return { created, updated };
}

/* ---------- account bookkeeping ---------- */

async function countAccountReels(accountId, fallback = 0) {
  try {
    return await InstagramReel.count({ where: { accountId } });
  } catch (err) {
    logger.warn(`[InstagramSyncService] Could not count reels for account ${accountId}: ${errorMessage(err)}`);
    return fallback;
  }
}

/** Writes sync status + the true reel count onto the account (all count column variants). */
async function writeAccountState(account, { status, error, totalReels }) {
  const payload = pickModelFields(InstagramAccount, {
    lastSyncedAt: new Date(),
    lastSyncStatus: status,
    lastSyncError: error ? errorMessage(error) : null,
    reelsCount: totalReels,
    reelCount: totalReels,
    videoCount: totalReels,
  });
  try {
    await account.update(payload);
  } catch (err) {
    logger.error(`[InstagramSyncService] Failed to save sync state for account ${account.id}: ${errorMessage(err)}`);
  }
}

/* ---------- public API ---------- */

const inFlight = new Map(); // accountId -> Promise, so the same account is never synced twice at once

async function runAccountSync(accountId) {
  let account = null;
  try {
    account = await InstagramAccount.findByPk(accountId);
  } catch (err) {
    logger.error(`[InstagramSyncService] Failed to load account ${accountId}: ${errorMessage(err)}`);
    return { success: false, totalReels: 0, created: 0, updated: 0 };
  }

  if (!account) {
    logger.warn(`[InstagramSyncService] Account ${accountId} not found.`);
    return { success: false, totalReels: 0, created: 0, updated: 0 };
  }

  if (account.isActive === false) {
    logger.info(`[InstagramSyncService] Account ${account.username || account.handle} is inactive, skipping.`);
    return { success: false, totalReels: 0, created: 0, updated: 0 };
  }

  const cleanUsername = sanitizeHandle(account.username || account.handle);
  if (!cleanUsername) {
    logger.error(`[InstagramSyncService] Account ${accountId} has no valid username/handle.`);
    await writeAccountState(account, {
      status: 'FAILED',
      error: new Error('Missing Instagram username/handle'),
      totalReels: await countAccountReels(account.id),
    });
    return { success: false, totalReels: 0, created: 0, updated: 0 };
  }

  const startedAt = Date.now();
  logger.info(`[InstagramSyncService] Syncing @${cleanUsername} (ID: ${account.id})`);

  try {
    const { reels: rawReels, source, attempts } = await scrapeWithFallback(cleanUsername, account);
    const rows = normalizeAndDedupe(rawReels, account, cleanUsername);
    const { created, updated } = await upsertReels(rows);

    // The true number of reels stored for this account (fixes the "0 reels" admin issue).
    const totalReels = await countAccountReels(account.id, rows.length);

    // Failed only when nothing was found AND every scraper that ran threw an error.
    const ran = attempts.filter((a) => a.attempted);
    const allErrored = ran.length > 0 && ran.every((a) => a.error);
    const scrapeFailed = rows.length === 0 && allErrored;

    await writeAccountState(account, {
      status: scrapeFailed ? 'FAILED' : 'SUCCESS',
      error: scrapeFailed ? ran[ran.length - 1].error : null,
      totalReels,
    });

    logger.info(
      `[InstagramSyncService] @${cleanUsername} done in ${Date.now() - startedAt}ms ` +
        `(source: ${source || 'none'}, scraped: ${rows.length}, new: ${created}, updated: ${updated}, total in DB: ${totalReels})`
    );

    return { success: !scrapeFailed, totalReels, created, updated };
  } catch (err) {
    logger.error(`[InstagramSyncService] Sync failed for @${cleanUsername}: ${errorMessage(err)}`);
    await writeAccountState(account, {
      status: 'FAILED',
      error: err,
      totalReels: await countAccountReels(account.id),
    });
    return { success: false, totalReels: 0, created: 0, updated: 0 };
  }
}

function syncAccountDetailed(accountId) {
  const key = String(accountId);
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = runAccountSync(accountId).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Syncs one Instagram account.
 * @param {string|number} accountId
 * @returns {Promise<number>} total reels stored in the database for this account
 */
async function syncAccount(accountId) {
  const result = await syncAccountDetailed(accountId);
  return result.totalReels;
}

let batchRunning = false;

/**
 * Syncs every active account with limited parallelism. One failing account never stops the batch,
 * and two overlapping batch runs (for example two cron ticks) are prevented.
 * @returns {Promise<{total:number, succeeded:number, failed:number, totalReels:number, durationMs:number}|null>}
 */
async function syncAllAccounts() {
  if (batchRunning) {
    logger.warn('[InstagramSyncService] A batch sync is already running. Skipping this run.');
    return null;
  }
  batchRunning = true;
  const startedAt = Date.now();

  try {
    let accounts = [];
    try {
      accounts = await InstagramAccount.findAll({ where: { isActive: true }, attributes: ['id'] });
    } catch (err) {
      logger.error(`[InstagramSyncService] Failed to query active accounts: ${errorMessage(err)}`);
      return null;
    }

    if (!Array.isArray(accounts) || accounts.length === 0) {
      logger.info('[InstagramSyncService] No active Instagram accounts to sync.');
      return { total: 0, succeeded: 0, failed: 0, totalReels: 0, durationMs: Date.now() - startedAt };
    }

    logger.info(`[InstagramSyncService] Batch sync started for ${accounts.length} accounts (concurrency ${CONFIG.ACCOUNT_CONCURRENCY}).`);

    const results = await mapWithConcurrency(accounts, CONFIG.ACCOUNT_CONCURRENCY, async (account) => {
      try {
        return await syncAccountDetailed(account.id);
      } catch (err) {
        logger.error(`[InstagramSyncService] Unhandled error syncing account ${account.id}: ${errorMessage(err)}`);
        return { success: false, totalReels: 0, created: 0, updated: 0 };
      }
    });

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r && r.success).length,
      failed: results.filter((r) => !r || !r.success).length,
      totalReels: results.reduce((sum, r) => sum + (r ? r.totalReels : 0), 0),
      durationMs: Date.now() - startedAt,
    };

    logger.info(
      `[InstagramSyncService] Batch finished in ${summary.durationMs}ms: ` +
        `${summary.succeeded}/${summary.total} ok, ${summary.failed} failed, ${summary.totalReels} reels in DB.`
    );
    return summary;
  } finally {
    batchRunning = false;
  }
}

module.exports = {
  syncAccount,
  syncAllAccounts,
  sanitizeHandle,
};