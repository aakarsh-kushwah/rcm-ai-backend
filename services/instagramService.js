/**
 * @file instagramService.js
 * @description DB-backed Instagram Reels integration service for Shorts/Feed architecture.
 */

const { InstagramAccount, InstagramReel } = require('../models');
const { logger } = require('../utils/logger');
const { Op } = require('sequelize');
const { fetchFullProfileReels } = require('./fullProfileReelsScraper');

const userInstagramLikes = new Map(); // userId -> Set of reel ids
const IG_ACCOUNT_DELAY_MS = parseInt(process.env.IG_ACCOUNT_DELAY_MS || '2500', 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setIfAttributeExists(instance, attr, value) {
  if (!instance || !instance.rawAttributes) return;
  if (Object.prototype.hasOwnProperty.call(instance.rawAttributes, attr)) {
    instance[attr] = value;
  }
}

const instagramService = {
  startSyncWorker: (options = {}) => {
    const { intervalMs = 15 * 60 * 1000, onSynced } = options;
    if (instagramService.syncWorkerTimer) return;

    logger.info('[InstagramService] Starting background sync worker...');
    instagramService.syncWorkerTimer = setInterval(async () => {
      try {
        logger.info('[InstagramService] Running background sync tick...');
        if (typeof onSynced === 'function') {
          await onSynced();
        }
      } catch (err) {
        logger.error(`[InstagramService] Sync worker error: ${err.message}`);
      }
    }, intervalMs);

    if (instagramService.syncWorkerTimer.unref) instagramService.syncWorkerTimer.unref();
  },

  stopSyncWorker: () => {
    if (instagramService.syncWorkerTimer) {
      clearInterval(instagramService.syncWorkerTimer);
      instagramService.syncWorkerTimer = null;
    }
  },

  getCatalogBatch: async ({ limit = 50 } = {}) => {
    try {
      const reels = await InstagramReel.findAll({
        where: {
          isActive: true,
          videoUrl: { [Op.ne]: null, [Op.ne]: '' },
        },
        attributes: ['id', 'likesCount'],
        limit,
        order: [['id', 'DESC']],
      });

      const results = [];
      let scoreBase = 1000.0;
      for (const reel of reels) {
        results.push({
          id: `ig_${reel.id}`,
          score: scoreBase + (Number(reel.likesCount) || 0) * 0.1,
        });
        scoreBase -= 10.0;
      }
      return results;
    } catch (err) {
      logger.error({ err: err.message }, '[InstagramService] getCatalogBatch error');
      return [];
    }
  },

  hydrateReels: async (igIds) => {
    const hydrated = [];
    if (!igIds || igIds.length === 0) return hydrated;

    try {
      const numericIds = igIds
        .map((id) =>
          String(id).startsWith('ig_') ? parseInt(String(id).replace('ig_', ''), 10) : parseInt(id, 10)
        )
        .filter((n) => !isNaN(n));

      if (numericIds.length === 0) return hydrated;

      const reels = await InstagramReel.findAll({
        where: {
          id: { [Op.in]: numericIds },
          isActive: true,
          videoUrl: { [Op.ne]: null, [Op.ne]: '' },
        },
        include: [{ model: InstagramAccount, as: 'account', required: false }],
      });

      const reelMap = new Map();
      for (const reel of reels) {
        const idStr = `ig_${reel.id}`;
        const account = reel.account || {};
        reelMap.set(idStr, {
          id: idStr,
          platform: 'instagram',
          shortcode: reel.shortcode,
          title: reel.title || `Instagram Reel ${reel.shortcode}`,
          category: reel.category || 'Motivation',
          thumbnail: reel.thumbnailUrl || '',
          videoUrl: reel.videoUrl,
          likesCount: Number(reel.likesCount) || 0,
          commentsCount: Number(reel.commentsCount) || 0,
          viewCount: Number(reel.viewCount) || 0,
          isActive: reel.isActive,
          instagram: {
            embedUrl: `https://www.instagram.com/reel/${reel.shortcode}/embed/`,
            shortcode: reel.shortcode,
          },
          channel: {
            id: account.id ? String(account.id) : 'ig_manual',
            name: account.displayName || account.username || 'Instagram Creator',
            handle: account.username || 'instagram',
            logoUrl:
              account.avatarUrl ||
              'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&q=80',
            verified: true,
          },
        });
      }

      for (const id of igIds) {
        if (reelMap.has(id)) {
          hydrated.push(reelMap.get(id));
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, '[InstagramService] hydrateReels error');
    }

    return hydrated;
  },

  getLikedSet: async (userId, igIds) => {
    const liked = new Set();
    if (!userId) return liked;
    const userLikes = userInstagramLikes.get(String(userId));
    if (userLikes) {
      for (const id of igIds) {
        if (userLikes.has(id)) liked.add(id);
      }
    }
    return liked;
  },

  toggleLike: async (userId, id) => {
    if (!userId) throw new Error('Authentication required to like Instagram reels.');
    const uKey = String(userId);
    if (!userInstagramLikes.has(uKey)) {
      userInstagramLikes.set(uKey, new Set());
    }
    const userLikes = userInstagramLikes.get(uKey);

    const numericId = parseInt(String(id).replace('ig_', ''), 10);
    const reel = await InstagramReel.findByPk(numericId);
    if (!reel) throw new Error('Instagram reel not found.');

    let isLiked = false;
    let likesCount = Number(reel.likesCount) || 0;
    if (userLikes.has(id)) {
      userLikes.delete(id);
      isLiked = false;
      likesCount = Math.max(0, likesCount - 1);
    } else {
      userLikes.add(id);
      isLiked = true;
      likesCount += 1;
    }

    reel.likesCount = likesCount;
    await reel.save();

    return {
      isLiked,
      likesCount,
    };
  },

  syncAccountReels: async (accountId, username) => {
    let account = null;
    try {
      logger.info(`[InstagramService] Starting sync for account ID ${accountId} (@${username})...`);
      account = await InstagramAccount.findByPk(accountId);
      if (!account) {
        throw new Error(`Instagram account ${accountId} not found.`);
      }

      setIfAttributeExists(account, 'lastSyncStatus', 'syncing');
      setIfAttributeExists(account, 'lastSyncError', null);
      if (account.changed()) {
        await account.save();
      }

      const cleanUsername = String(username || account.username || '').replace(/^@/, '').trim();
      let scrapedReels = [];
      let scrapeErrorMessage = null;

      try {
        scrapedReels = await fetchFullProfileReels(cleanUsername, {
          accountId: account.id,
          category: account.category || 'Motivation',
          mode: 'full',
        });
      } catch (scrapeErr) {
        scrapeErrorMessage = scrapeErr.message;
        logger.warn(
          `[InstagramService] Fetch full profile reels warning for @${cleanUsername}: ${scrapeErr.message}`
        );
      }

      const reelsToIngest = scrapedReels.map((reel) => ({
        accountId: account.id,
        shortcode: reel.shortcode,
        url: reel.url,
        videoUrl: reel.videoUrl || null,
        title: String(reel.title || `Instagram Reel ${reel.shortcode}`).trim().slice(0, 500),
        thumbnailUrl: reel.thumbnailUrl,
        creatorHandle: cleanUsername,
        category: account.category || 'Motivation',
        isActive: true,
      }));

      if (reelsToIngest.length > 0) {
        await InstagramReel.bulkCreate(reelsToIngest, {
          updateOnDuplicate: ['thumbnailUrl', 'updatedAt', 'title', 'url', 'videoUrl'],
        });
      }

      const reelsCount = await InstagramReel.count({ where: { accountId: account.id } });
      const status =
        reelsToIngest.length > 0
          ? 'ok'
          : scrapeErrorMessage
          ? 'warning'
          : 'rate_limited_or_empty';

      const reason =
        reelsToIngest.length > 0
          ? null
          : scrapeErrorMessage ||
            '0 reels returned by Instagram HTTP scraper (likely 429 rate-limit or login gate; existing reels kept).';

      account.reelsCount = reelsCount;
      account.lastSyncedAt = new Date();
      setIfAttributeExists(account, 'lastSyncStatus', status);
      setIfAttributeExists(account, 'lastSyncError', reason);
      await account.save();

      if (typeof global.invalidateFeedCandidateCache === 'function') {
        global.invalidateFeedCandidateCache();
      }

      logger.info(
        `[InstagramService] Synced @${cleanUsername}: ${reelsToIngest.length} scraped, total account reels: ${reelsCount}, status=${status}`
      );

      return {
        success: true,
        status,
        reason,
        scrapedCount: reelsToIngest.length,
        reelsCount,
        lastSyncedAt: account.lastSyncedAt,
      };
    } catch (err) {
      logger.error(
        { err: err.message },
        `[InstagramService] syncAccountReels failed for accountId ${accountId}`
      );
      if (account) {
        try {
          setIfAttributeExists(account, 'lastSyncStatus', 'error');
          setIfAttributeExists(account, 'lastSyncError', String(err.message).slice(0, 500));
          await account.save();
        } catch (_) {}
      }
      throw err;
    }
  },

  syncAccountsSequentially: async (accounts = []) => {
    const results = [];
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      try {
        const res = await instagramService.syncAccountReels(acc.id, acc.username);
        results.push({ accountId: acc.id, username: acc.username, ...res });
      } catch (err) {
        results.push({
          accountId: acc.id,
          username: acc.username,
          success: false,
          status: 'error',
          reason: err.message,
        });
      }
      if (i < accounts.length - 1 && IG_ACCOUNT_DELAY_MS > 0) {
        await sleep(IG_ACCOUNT_DELAY_MS);
      }
    }
    return results;
  },
};

module.exports = instagramService;