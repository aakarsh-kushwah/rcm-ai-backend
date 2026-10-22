/**
 * @file instagramController.js
 * @description TiDB-backed admin controller for Instagram accounts & reels.
 * No scraping: reels are added by URL (single or bulk); title/thumbnail are edited manually.
 */

const { InstagramAccount, InstagramReel } = require('../models');
const { Op } = require('sequelize');
const { logger } = require('../utils/logger');
const instagramService = require('../services/instagramService');
const { cleanInstagramUsername } = require('../utils/instagramSanitizer');
const { fetchFullProfileReels } = require('../services/fullProfileReelsScraper');


function invalidateFeedCache() {
  if (global.invalidateFeedCandidateCache) global.invalidateFeedCandidateCache();
}

const cleanCategory = (c) => (typeof c === 'string' && c.trim() ? c.trim().slice(0, 50) : 'Motivation');
const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());

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

      // 1. Return immediate success response to prevent admin UI timeout
      res.status(200).json({
        success: true,
        message: `Import for @${username} initiated. Reels will be scraped in the background.`,
        data: { username },
      });

      // 2. Process account creation/update and scraping in the background
      setImmediate(async () => {
        try {
          let [account, created] = await InstagramAccount.findOrCreate({
            where: { username },
            defaults: {
              username,
              displayName: username,
              category,
              reelsCount: 0, // Initialize reelsCount to 0 for new accounts
              isActive: true,
              lastSyncedAt: new Date(),
            },
          });

          if (!created) {
            // If account exists, update its category if provided
            if (account.category !== category) {
              account.category = category;
              await account.save();
            }
          }

          logger.info(`[InstagramController] Background: Initiating full profile reel scrape for @${username} (Account ID: ${account.id})`);

          const scrapedReels = await fetchFullProfileReels(username, {
            accountId: account.id,
            category: account.category,
            sessionId: process.env.INSTAGRAM_SESSION_ID,
          });

          if (scrapedReels.length > 0) {
            await InstagramReel.bulkCreate(scrapedReels, {
              updateOnDuplicate: ['thumbnailUrl', 'updatedAt', 'title', 'url', 'videoUrl', 'creatorHandle', 'category', 'likesCount', 'commentsCount', 'viewCount'],
            });
            logger.info(`[InstagramController] Background: Successfully ingested ${scrapedReels.length} reels for @${username}.`);
          } else {
            logger.info(`[InstagramController] Background: No new reels found for @${username} during scrape.`);
          }

          // Update reelsCount and lastSyncedAt after scraping
          const reelsCount = await InstagramReel.count({ where: { accountId: account.id } });
          account.reelsCount = reelsCount;
          account.lastSyncedAt = new Date();
          await account.save();

          invalidateFeedCache();
          logger.info(`[InstagramController] Background: Completed sync for @${username}. Total reels: ${reelsCount}`);
        } catch (backgroundErr) {
          logger.error({ err: backgroundErr.message, stack: backgroundErr.stack, username }, '[InstagramController] Background scraping or DB update failed');
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

      // Immediate response for bulk import as well
      res.status(200).json({ success: true, message: 'Bulk import initiated. Processing in background.' });

      setImmediate(async () => {
        const result = { imported: 0, skipped: 0, accounts: 0, invalid: [] };
        for (const item of items) {
          const username = cleanInstagramUsername(item);
          if (!username) {
            result.invalid.push(item);
            continue;
          }

          try {
            let [account, created] = await InstagramAccount.findOrCreate({
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

            if (created) {
              result.accounts += 1;
            } else {
              result.skipped += 1;
              if (account.category !== category) {
                account.category = category;
                await account.save();
              }
            }

            logger.info(`[InstagramController] Background Bulk: Initiating full profile reel scrape for @${username} (Account ID: ${account.id})`);
            const scrapedReels = await fetchFullProfileReels(username, {
              accountId: account.id,
              category: account.category,
              sessionId: process.env.INSTAGRAM_SESSION_ID,
            });

            if (scrapedReels.length > 0) {
              await InstagramReel.bulkCreate(scrapedReels, {
                updateOnDuplicate: ['thumbnailUrl', 'updatedAt', 'title', 'url', 'videoUrl', 'creatorHandle', 'category', 'likesCount', 'commentsCount', 'viewCount'],
              });
              result.imported += scrapedReels.length; // Count imported reels
              logger.info(`[InstagramController] Background Bulk: Successfully ingested ${scrapedReels.length} reels for @${username}.`);
            } else {
              logger.info(`[InstagramController] Background Bulk: No new reels found for @${username} during scrape.`);
            }

            const reelsCount = await InstagramReel.count({ where: { accountId: account.id } });
            account.reelsCount = reelsCount;
            account.lastSyncedAt = new Date();
            await account.save();

          } catch (itemErr) {
            logger.error({ err: itemErr.message, stack: itemErr.stack, item }, '[InstagramController] Background Bulk: Error processing item');
            result.invalid.push(item); // Treat as invalid if background processing fails
          }
        }
        invalidateFeedCache();
        logger.info(`[InstagramController] Background Bulk: Finished processing all items. Result: ${JSON.stringify(result)}`);
      });

    } catch (err) {
      logger.error({ err: err.message }, '[InstagramController] bulkImport error');
      next(err);
    }
  },

  getAccounts: async (req, res, next) => {
    try {
      const accounts = await InstagramAccount.findAll({
        attributes: ['id', 'username', 'displayName', 'avatarUrl', 'category', 'reelsCount', 'lastSyncedAt', 'isActive', 'createdAt'],
        order: [['createdAt', 'DESC']],
      });
      return res.status(200).json({ success: true, data: accounts });
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

      const attributes = ['id', 'accountId', 'shortcode', 'url', 'title', 'thumbnailUrl', 'videoUrl', 'creatorHandle', 'category', 'likesCount', 'commentsCount', 'viewCount', 'isActive', 'createdAt'];

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
          pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) || 1, hasMore: page * limit < count },
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
      const account = await InstagramAccount.findByPk(accountId, { attributes: ['id', 'username'] });
      if (!account) {
        logger.warn(`[InstagramController] 404: Sync request for non-existent account ID: ${accountId}`);
        return res.status(404).json({ success: false, message: 'Instagram account not found.' });
      }

      // 1. Return immediate success response to prevent admin UI timeout
      res.status(200).json({
        success: true,
        message: `Sync for @${account.username} initiated. Reels will be scraped in the background.`,
        count: 0, // Initial count, will be updated by background process
      });

      // 2. Process account scraping in the background
      setImmediate(async () => {
        try {
          logger.info(`[InstagramController] Background: Initiating single account sync for @${account.username} (Account ID: ${account.id})`);
          const syncResult = await instagramService.syncAccountReels(account.id, account.username);
          
          // After background process completes, update account details and invalidate cache
          const reelsCount = await InstagramReel.count({ where: { accountId: account.id } });
          account.reelsCount = reelsCount;
          account.lastSyncedAt = new Date();
          await account.save();

          invalidateFeedCache();
          logger.info(`[InstagramController] Background: Completed single account sync for @${account.username}. Total reels: ${reelsCount}, new reels: ${syncResult.newReelsCount || 0}`);
          // TODO: Potentially notify admin UI of completion and final count via websocket if needed.
        } catch (backgroundErr) {
          logger.error({ err: backgroundErr.message, stack: backgroundErr.stack, accountId: account.id, username: account.username }, '[InstagramController] Background single account sync failed');
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
      return res.status(200).json({ success: true, message: 'Account status toggled successfully', data: { id: account.id, isActive: account.isActive } });
    } catch (err) {
      next(err);
    }
  },

  deleteAccount: async (req, res, next) => {
    try {
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
      return res.status(200).json({ success: true, message: 'Reel status toggled successfully', data: { id: reel.id, isActive: reel.isActive } });
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