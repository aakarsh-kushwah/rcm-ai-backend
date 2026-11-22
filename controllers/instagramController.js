/**
 * @file instagramController.js
 * @description TiDB-backed admin controller for Instagram accounts & reels with live sync visibility.
 */

const { InstagramAccount, InstagramReel } = require('../models');
const { Op } = require('sequelize');
const { logger } = require('../utils/logger');
const instagramService = require('../services/instagramService');
const { cleanInstagramUsername } = require('../utils/instagramSanitizer');
const { fetchFullProfileReels } = require('./fullProfileReelsScraper');

const BULK_MAX = 25;
const BULK_ITEM_DELAY_MS = 2500;

// In-memory live sync tracker so Admin UI can show real-time status & clear reasons
const liveSyncTracker = new Map(); // accountId -> { accountId, username, status, scrapedCount, newReelsCount, totalReels, reason, startedAt, finishedAt }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function invalidateFeedCache() {
  if (global.invalidateFeedCandidateCache) global.invalidateFeedCandidateCache();
}

const cleanCategory = (c) => (typeof c === 'string' && c.trim() ? c.trim().slice(0, 50) : 'Motivation');
const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());

function setTrackerState(accountId, patch) {
  const key = String(accountId);
  const prev = liveSyncTracker.get(key) || {
    accountId: Number(accountId) || accountId,
    status: 'idle',
    scrapedCount: 0,
    newReelsCount: 0,
    totalReels: 0,
    reason: null,
    startedAt: null,
    finishedAt: null,
  };
  const next = { ...prev, ...patch };
  liveSyncTracker.set(key, next);
  return next;
}

const instagramController = {
  // POST /import  { input|url|link|value, category }
  importReelOrAccount: async (req, res, next) => {
    try {
      const rawInput = req.body.input || req.body.url || req.body.link || req.body.value;
      const category = cleanCategory(req.body.category);
      const username = cleanInstagramUsername(rawInput);

      if (!username) {
        logger.warn({ bodyKeys: Object.keys(req.body || {}) }, '[InstagramController] 400: invalid input');
        return res.status(400).json({
          success: false,
          message: 'Invalid input. Provide a valid Instagram username or profile URL.',
        });
      }

      const [account, created] = await InstagramAccount.findOrCreate({
        where: { username },
        defaults: {
          username,
          displayName: username,
          category,
          reelsCount: 0,
          isActive: true,
          lastSyncedAt: new Date(),
        },
      });

      if (!created && account.category !== category) {
        account.category = category;
        await account.save();
      }

      setTrackerState(account.id, {
        accountId: account.id,
        username,
        status: 'syncing',
        scrapedCount: 0,
        newReelsCount: 0,
        totalReels: account.reelsCount || 0,
        reason: 'Scraping reels in background...',
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });

      res.status(200).json({
        success: true,
        message: `Import for @${username} started. Scraper is running in background.`,
        data: { id: account.id, username, status: 'syncing' },
      });

      setImmediate(async () => {
        try {
          const beforeCount = await InstagramReel.count({ where: { accountId: account.id } });
          const syncResult = await instagramService.syncAccountReels(account.id, username);
          const afterCount = syncResult.reelsCount ?? (await InstagramReel.count({ where: { accountId: account.id } }));
          const newAdded = Math.max(0, afterCount - beforeCount);

          setTrackerState(account.id, {
            accountId: account.id,
            username,
            status: syncResult.status || (syncResult.scrapedCount > 0 ? 'ok' : 'rate_limited_or_empty'),
            scrapedCount: syncResult.scrapedCount || 0,
            newReelsCount: newAdded,
            totalReels: afterCount,
            reason: syncResult.reason || null,
            finishedAt: new Date().toISOString(),
          });

          invalidateFeedCache();
        } catch (backgroundErr) {
          logger.error(
            { err: backgroundErr.message, username },
            '[InstagramController] Background scraping or DB update failed'
          );
          setTrackerState(account.id, {
            accountId: account.id,
            username,
            status: 'error',
            reason: backgroundErr.message,
            finishedAt: new Date().toISOString(),
          });
        }
      });
    } catch (err) {
      logger.error({ err: err.message }, '[InstagramController] importReelOrAccount error');
      next(err);
    }
  },

  // POST /import-bulk  { text: "url\nurl\n...", inputs: [..], category }
  bulkImport: async (req, res, next) => {
    try {
      const category = cleanCategory(req.body.category);
      let items = [];
      if (Array.isArray(req.body.inputs)) items = req.body.inputs;
      else if (typeof req.body.text === 'string') items = req.body.text.split(/[\s,]+/);
      items = [...new Set(items.map((x) => String(x).trim()).filter(Boolean))];

      if (items.length === 0) return res.status(400).json({ success: false, message: 'No URLs provided.' });
      if (items.length > BULK_MAX) {
        return res.status(400).json({ success: false, message: `Max ${BULK_MAX} items per request.` });
      }

      res.status(200).json({
        success: true,
        message: `Bulk import for ${items.length} item(s) started. Running slowly in background to avoid rate limits.`,
      });

      setImmediate(async () => {
        const result = { imported: 0, skipped: 0, accounts: 0, invalid: [] };
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const username = cleanInstagramUsername(item);
          if (!username) {
            result.invalid.push(item);
            continue;
          }

          try {
            const [account, created] = await InstagramAccount.findOrCreate({
              where: { username },
              defaults: {
                username,
                displayName: username,
                category,
                reelsCount: 0,
                isActive: true,
                lastSyncedAt: new Date(),
              },
            });

            if (created) result.accounts += 1;
            else {
              result.skipped += 1;
              if (account.category !== category) {
                account.category = category;
                await account.save();
              }
            }

            setTrackerState(account.id, {
              accountId: account.id,
              username,
              status: 'syncing',
              scrapedCount: 0,
              newReelsCount: 0,
              totalReels: account.reelsCount || 0,
              reason: `Bulk queue (${i + 1}/${items.length}) running...`,
              startedAt: new Date().toISOString(),
              finishedAt: null,
            });

            const beforeCount = await InstagramReel.count({ where: { accountId: account.id } });
            const syncResult = await instagramService.syncAccountReels(account.id, username);
            const afterCount = syncResult.reelsCount ?? beforeCount;
            const newAdded = Math.max(0, afterCount - beforeCount);
            result.imported += newAdded;

            setTrackerState(account.id, {
              accountId: account.id,
              username,
              status: syncResult.status || 'ok',
              scrapedCount: syncResult.scrapedCount || 0,
              newReelsCount: newAdded,
              totalReels: afterCount,
              reason: syncResult.reason || null,
              finishedAt: new Date().toISOString(),
            });
          } catch (itemErr) {
            logger.error({ err: itemErr.message, item }, '[InstagramController] Background Bulk: Error processing item');
            result.invalid.push(item);
          }

          if (i < items.length - 1) {
            await sleep(BULK_ITEM_DELAY_MS);
          }
        }
        invalidateFeedCache();
        logger.info(`[InstagramController] Background Bulk finished: ${JSON.stringify(result)}`);
      });
    } catch (err) {
      logger.error({ err: err.message }, '[InstagramController] bulkImport error');
      next(err);
    }
  },

  // GET /sync/activity
  getSyncActivity: async (req, res, next) => {
    try {
      const items = Array.from(liveSyncTracker.values()).sort((a, b) => {
        const ta = new Date(b.startedAt || b.finishedAt || 0).getTime();
        const tb = new Date(a.startedAt || a.finishedAt || 0).getTime();
        return ta - tb;
      });
      const activeCount = items.filter((x) => x.status === 'syncing').length;
      return res.status(200).json({
        success: true,
        activeCount,
        isRunning: activeCount > 0,
        items,
      });
    } catch (err) {
      next(err);
    }
  },

  getAccounts: async (req, res, next) => {
    try {
      const accounts = await InstagramAccount.findAll({
        order: [['createdAt', 'DESC']],
      });

      const enriched = accounts.map((acc) => {
        const plain = acc.toJSON();
        const live = liveSyncTracker.get(String(plain.id));
        return {
          ...plain,
          syncStatus: live?.status || plain.lastSyncStatus || 'idle',
          syncReason: live?.reason || plain.lastSyncError || null,
          lastScrapedCount: live?.scrapedCount ?? null,
          lastNewReelsCount: live?.newReelsCount ?? null,
        };
      });

      return res.status(200).json({ success: true, data: enriched });
    } catch (err) {
      next(err);
    }
  },

  // GET /reels?page=1&limit=10  (admin: page based)  or ?cursor=<id> (keyset)
  getReels: async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const page = parseInt(req.query.page, 10) || 0;
      const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;

      const where = {};
      if (req.query.category) where.category = req.query.category;
      if (req.query.accountId) where.accountId = req.query.accountId;

      const attributes = [
        'id',
        'accountId',
        'shortcode',
        'url',
        'title',
        'thumbnailUrl',
        'videoUrl',
        'creatorHandle',
        'category',
        'likesCount',
        'commentsCount',
        'viewCount',
        'isActive',
        'createdAt',
      ];

      if (page > 0) {
        const { count, rows } = await InstagramReel.findAndCountAll({
          where,
          attributes,
          order: [['id', 'DESC']],
          limit,
          offset: (page - 1) * limit,
        });
        return res.status(200).json({
          success: true,
          data: rows,
          pagination: {
            page,
            limit,
            total: count,
            totalPages: Math.ceil(count / limit) || 1,
            hasMore: page * limit < count,
          },
        });
      }

      if (cursor) where.id = { [Op.lt]: cursor };
      const rows = await InstagramReel.findAll({ where, attributes, limit: limit + 1, order: [['id', 'DESC']] });
      let nextCursor = null;
      if (rows.length > limit) {
        rows.pop();
        nextCursor = rows[rows.length - 1].id;
      }
      return res.status(200).json({ success: true, data: rows, pagination: { limit, nextCursor, hasMore: nextCursor !== null } });
    } catch (err) {
      next(err);
    }
  },

  // PATCH /reels/:id  { title, thumbnailUrl, videoUrl, creatorHandle, category, isActive }
  updateReel: async (req, res, next) => {
    try {
      const reel = await InstagramReel.findByPk(req.params.id);
      if (!reel) return res.status(404).json({ success: false, message: 'Instagram reel not found.' });

      const b = req.body || {};
      const patch = {};
      if (typeof b.title === 'string') patch.title = b.title.trim().slice(0, 500);
      if (b.thumbnailUrl !== undefined) {
        if (b.thumbnailUrl && !isHttpUrl(b.thumbnailUrl)) {
          return res.status(400).json({ success: false, message: 'thumbnailUrl must be an http(s) URL.' });
        }
        patch.thumbnailUrl = (b.thumbnailUrl || '').trim();
      }
      if (b.videoUrl !== undefined) {
        if (b.videoUrl && !isHttpUrl(b.videoUrl)) {
          return res.status(400).json({ success: false, message: 'videoUrl must be an http(s) URL.' });
        }
        patch.videoUrl = (b.videoUrl || '').trim();
      }
      if (typeof b.creatorHandle === 'string') patch.creatorHandle = b.creatorHandle.trim().replace(/^@/, '').slice(0, 100);
      if (typeof b.category === 'string' && b.category.trim()) patch.category = b.category.trim().slice(0, 50);
      if (typeof b.isActive === 'boolean') patch.isActive = b.isActive;

      await reel.update(patch);
      invalidateFeedCache();
      return res.status(200).json({ success: true, message: 'Reel updated.', data: reel });
    } catch (err) {
      next(err);
    }
  },

  // POST /accounts/:id/sync
  syncAccount: async (req, res, next) => {
    try {
      const accountId = req.params.id;
      const account = await InstagramAccount.findByPk(accountId);
      if (!account) {
        logger.warn(`[InstagramController] 404: Sync request for non-existent account ID: ${accountId}`);
        return res.status(404).json({ success: false, message: 'Instagram account not found.' });
      }

      const currentState = liveSyncTracker.get(String(account.id));
      if (currentState && currentState.status === 'syncing') {
        return res.status(200).json({
          success: true,
          alreadyRunning: true,
          message: `Sync is already running for @${account.username}.`,
          data: currentState,
        });
      }

      const state = setTrackerState(account.id, {
        accountId: account.id,
        username: account.username,
        status: 'syncing',
        scrapedCount: 0,
        newReelsCount: 0,
        totalReels: account.reelsCount || 0,
        reason: 'Scraping reels in background...',
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });

      res.status(200).json({
        success: true,
        message: `Sync started for @${account.username}.`,
        data: state,
      });

      setImmediate(async () => {
        try {
          logger.info(
            `[InstagramController] Background: Initiating single account sync for @${account.username} (Account ID: ${account.id})`
          );
          const beforeCount = await InstagramReel.count({ where: { accountId: account.id } });
          const syncResult = await instagramService.syncAccountReels(account.id, account.username);
          const afterCount = syncResult.reelsCount ?? (await InstagramReel.count({ where: { accountId: account.id } }));
          const newAdded = Math.max(0, afterCount - beforeCount);

          setTrackerState(account.id, {
            accountId: account.id,
            username: account.username,
            status: syncResult.status || (syncResult.scrapedCount > 0 ? 'ok' : 'rate_limited_or_empty'),
            scrapedCount: syncResult.scrapedCount || 0,
            newReelsCount: newAdded,
            totalReels: afterCount,
            reason: syncResult.reason || null,
            finishedAt: new Date().toISOString(),
          });

          invalidateFeedCache();
          logger.info(
            `[InstagramController] Background: Completed single account sync for @${account.username}. Total reels: ${afterCount}, new reels: ${newAdded}, status=${syncResult.status}`
          );
        } catch (backgroundErr) {
          logger.error(
            { err: backgroundErr.message, accountId: account.id, username: account.username },
            '[InstagramController] Background single account sync failed'
          );
          setTrackerState(account.id, {
            accountId: account.id,
            username: account.username,
            status: 'error',
            reason: backgroundErr.message,
            finishedAt: new Date().toISOString(),
          });
        }
      });
    } catch (err) {
      logger.error({ err: err.message, accountId: req.params.id }, '[InstagramController] syncAccount error');
      next(err);
    }
  },

  toggleAccount: async (req, res, next) => {
    try {
      const account = await InstagramAccount.findByPk(req.params.id, { attributes: ['id', 'isActive'] });
      if (!account) return res.status(404).json({ success: false, message: 'Instagram account not found.' });
      account.isActive = !account.isActive;
      await account.save();
      invalidateFeedCache();
      return res.status(200).json({
        success: true,
        message: 'Account status toggled successfully',
        data: { id: account.id, isActive: account.isActive },
      });
    } catch (err) {
      next(err);
    }
  },

  deleteAccount: async (req, res, next) => {
    try {
      liveSyncTracker.delete(String(req.params.id));
      const deleted = await InstagramAccount.destroy({ where: { id: req.params.id } });
      if (!deleted) return res.status(404).json({ success: false, message: 'Instagram account not found.' });
      invalidateFeedCache();
      return res.status(200).json({ success: true, message: 'Instagram account deleted successfully.' });
    } catch (err) {
      next(err);
    }
  },

  toggleReel: async (req, res, next) => {
    try {
      const reel = await InstagramReel.findByPk(req.params.id, { attributes: ['id', 'isActive'] });
      if (!reel) return res.status(404).json({ success: false, message: 'Instagram reel not found.' });
      reel.isActive = !reel.isActive;
      await reel.save();
      invalidateFeedCache();
      return res.status(200).json({
        success: true,
        message: 'Reel status toggled successfully',
        data: { id: reel.id, isActive: reel.isActive },
      });
    } catch (err) {
      next(err);
    }
  },

  deleteReel: async (req, res, next) => {
    try {
      const deleted = await InstagramReel.destroy({ where: { id: req.params.id } });
      if (!deleted) return res.status(404).json({ success: false, message: 'Instagram reel not found.' });
      invalidateFeedCache();
      return res.status(200).json({ success: true, message: 'Instagram reel deleted successfully.' });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = instagramController;