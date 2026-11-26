/**
 * @file instagramController.js
 * @description TiDB-backed admin controller for Instagram accounts & reels.
 */

const { InstagramAccount, InstagramReel } = require('../models');
const { Op } = require('sequelize');
const { logger } = require('../utils/logger');
const { cleanInstagramUsername } = require('../utils/instagramSanitizer');

const BULK_MAX = 25;

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

      const [account, created] = await InstagramAccount.findOrCreate({
        where: { username },
        defaults: {
          username,
          displayName: username,
          category,
          reelsCount: 0,
          isActive: true,
        },
      });

      if (!created && account.category !== category) {
        account.category = category;
        await account.save();
      }

      res.status(200).json({
        success: true,
        message: `Account @${username} is ready for the local worker to sync.`,
        data: { id: account.id, username, status: 'pending' },
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
        message: `Bulk account registration for ${items.length} item(s) started.`,
      });

      setImmediate(async () => {
        const result = { accounts: 0, existing: 0, invalid: [] };
        for (const item of items) {
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
              },
            });

            if (created) result.accounts += 1;
            else {
              result.existing += 1;
              if (account.category !== category) {
                account.category = category;
                await account.save();
              }
            }

          } catch (itemErr) {
            logger.error({ err: itemErr.message, item }, '[InstagramController] Background Bulk: Error processing item');
            result.invalid.push(item);
          }

        }
        logger.info({ ...result }, '[InstagramController] Bulk account registration finished');
      });
    } catch (err) {
      logger.error({ err: err.message }, '[InstagramController] bulkImport error');
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
        return {
          ...plain,
          syncStatus: plain.lastSyncStatus || (plain.lastSyncedAt ? 'idle' : 'pending'),
          syncReason: plain.lastSyncError || null,
          lastScrapedCount: null,
          lastNewReelsCount: null,
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

      res.status(200).json({
        success: true,
        message: `Sync for @${account.username} will run when the local worker next starts.`,
        data: {
          accountId: account.id,
          username: account.username,
          status: 'pending',
        },
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