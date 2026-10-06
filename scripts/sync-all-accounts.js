/**
 * @file rcm-ai-backend/scripts/sync-all-accounts.js
 * @description Sync reels for all active Instagram accounts sequentially with delay.
 */

const { sequelize } = require('../config/db');
const { InstagramAccount, InstagramReel } = require('../models');
const instagramService = require('../services/instagramService');
const logger = require('../utils/logger');

async function syncAllAccounts() {
  console.log('🚀 Starting sync-all-accounts script...');
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection authenticated successfully.');

    const activeAccounts = await InstagramAccount.findAll({
      where: { isActive: true },
      attributes: ['id', 'username', 'isActive'],
    });

    console.log(`📋 Found ${activeAccounts.length} active Instagram account(s) to sync.`);

    for (const account of activeAccounts) {
      try {
        console.log(`⏳ Syncing account: @${account.username} (ID: ${account.id})...`);
        await instagramService.syncAccountReels(account.id, account.username);
        
        // Query count of reels present for this account
        const count = await InstagramReel.count({ where: { accountId: account.id } });
        
        console.log(`[SYNC SUCCESS] @${account.username}: Imported ${count} reels`);
      } catch (err) {
        console.error(`❌ [SYNC ERROR] @${account.username} failed: ${err.message}`);
        logger.error({ err: err.message }, `[SyncAllAccounts] Failed for @${account.username}`);
      }

      // Introduce 2-second delay between accounts to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('🎉 All active Instagram accounts synced successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Sync all accounts script failed:', error);
    logger.error({ err: error.message }, '[SyncAllAccounts] Fatal error');
    process.exit(1);
  }
}

syncAllAccounts();
