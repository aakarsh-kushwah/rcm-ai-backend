const InstagramAccount = require('../models/InstagramAccount');
const InstagramReel = require('../models/InstagramReel');
const { fetchFullProfileReels } = require('./fullProfileReelsScraper');
const { fetchProfileReels } = require('./instagramScraper');
const { logger } = require('../utils/logger');

/**
 * Syncs a single Instagram account by scraping its reels.
 * @param {string} accountId - The ID of the Instagram account to sync.
 * @returns {Promise<number>} Number of new reels added.
 */
async function syncAccount(accountId) {
  const account = await InstagramAccount.findByPk(accountId);
  if (!account) {
    logger.warn(`[InstagramSyncService] Account ${accountId} not found for sync.`);
    return 0;
  }

  if (!account.isActive) {
    logger.info(`[InstagramSyncService] Account ${account.username} is inactive, skipping sync.`);
    return 0;
  }

  logger.info(`[InstagramSyncService] Starting sync for Instagram account: @${account.username}`);
  let newReelsCount = 0;

  try {
    // Decide which scraper to use based on account configuration or other logic
    // For now, let's use fetchFullProfileReels for a comprehensive scrape
    const scrapedReelsData = await fetchFullProfileReels(account.username, { accountId: account.id, category: 'General' });

    for (const reelData of scrapedReelsData) {
      const [reel, created] = await InstagramReel.findOrCreate({
        where: { shortcode: reelData.shortcode },
        defaults: {
          accountId: account.id,
          creatorHandle: account.username,
          ...reelData,
        },
      });

      if (created) {
        newReelsCount++;
        logger.info(`[InstagramSyncService] Added new reel: ${reel.shortcode} for @${account.username}`);
      } else {
        // Optionally update existing reel data if needed
        if (!reel.videoUrl && reelData.videoUrl) {
          reel.videoUrl = reelData.videoUrl;
          await reel.save();
          logger.debug(`[InstagramSyncService] Updated videoUrl for existing reel: ${reel.shortcode}`);
        }
      }
    }

    account.lastSyncedAt = new Date();
    account.lastSyncStatus = 'SUCCESS';
    account.lastSyncError = null;
    await account.save();

    logger.info(`[InstagramSyncService] Sync completed for @${account.username}. Added ${newReelsCount} new reels.`);
    return newReelsCount;
  } catch (error) {
    logger.error(`[InstagramSyncService] Sync failed for @${account.username}: ${error.message}`);
    account.lastSyncedAt = new Date();
    account.lastSyncStatus = 'FAILED';
    account.lastSyncError = error.message;
    await account.save();
    return 0;
  }
}

/**
 * Syncs all active Instagram accounts.
 */
async function syncAllAccounts() {
  logger.info('[InstagramSyncService] Starting sync for all active Instagram accounts.');
  const accounts = typeof InstagramAccount.find === "function"
    ? await InstagramAccount.find({ isActive: true })
    : await InstagramAccount.findAll({ where: { isActive: true } });
  
  for (const account of accounts) {
    try {
      await syncAccount(account.id);
    } catch (error) {
      logger.error(`[InstagramSyncService] Error syncing account ${account.username}: ${error.message}`);
    }
  }
  logger.info('[InstagramSyncService] All active Instagram accounts sync process initiated.');
}

module.exports = {
  syncAccount,
  syncAllAccounts,
};
