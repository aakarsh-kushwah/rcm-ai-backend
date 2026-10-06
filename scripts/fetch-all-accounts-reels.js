/**
 * @file rcm-ai-backend/scripts/fetch-all-accounts-reels.js
 * @description Unlimited Instagram profile reels ingestion runner with rate limiting and summary reporting.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize } = require('../config/db');
const { InstagramAccount, InstagramReel } = require('../models');
const instagramService = require('../services/instagramService');
const { logger } = require('../utils/logger');

async function run() {
  console.log('===============================================================');
  console.log('🚀 [CRAWLER] Instagram Unlimited Profile Reels Ingestion Engine');
  console.log('===============================================================\n');

  const startTime = Date.now();
  const summary = [];

  try {
    console.log('🔌 Connecting to TiDB database...');
    await sequelize.authenticate();
    console.log('✅ Database connected successfully.\n');

    console.log('🔍 Fetching all active Instagram accounts...');
    const activeAccounts = await InstagramAccount.findAll({
      where: { isActive: true },
      order: [['id', 'ASC']],
    });

    console.log(`📋 Found ${activeAccounts.length} active account(s) to ingest.\n`);

    if (activeAccounts.length === 0) {
      console.log('⚠️ No active Instagram accounts found. Exiting.');
      process.exit(0);
    }

    for (let i = 0; i < activeAccounts.length; i++) {
      const account = activeAccounts[i];
      const username = account.username;
      const accountNum = i + 1;

      console.log(`---------------------------------------------------------------`);
      console.log(`[CRAWLER] [${accountNum}/${activeAccounts.length}] Starting @${username} (Account ID: ${account.id}, Category: ${account.category || 'Motivation'})...`);

      const accountStart = Date.now();
      let status = 'SUCCESS';
      let errorMsg = null;
      let scrapedCount = 0;
      let totalDbCount = 0;

      try {
        const syncResult = await instagramService.syncAccountReels(account.id, username);
        scrapedCount = syncResult.scrapedCount || 0;
        totalDbCount = syncResult.reelsCount || (await InstagramReel.count({ where: { accountId: account.id } }));

        const durationSec = ((Date.now() - accountStart) / 1000).toFixed(1);
        console.log(`[CRAWLER] ✅ Completed @${username}: Scraped ${scrapedCount} reels | DB Total: ${totalDbCount} | Duration: ${durationSec}s`);
      } catch (err) {
        status = 'FAILED';
        errorMsg = err.message;
        totalDbCount = await InstagramReel.count({ where: { accountId: account.id } });
        console.error(`[CRAWLER] ❌ Error syncing @${username}: ${err.message}`);
        logger.error({ err: err.message, username, accountId: account.id }, '[fetch-all-accounts-reels] Account sync failed');
      }

      summary.push({
        id: account.id,
        username: `@${username}`,
        category: account.category || 'Motivation',
        scrapedCount,
        totalDbCount,
        status,
        error: errorMsg || 'None',
      });

      // Rate-limiting delay of 2 seconds between accounts
      if (i < activeAccounts.length - 1) {
        console.log(`[CRAWLER] ⏳ Cooling down for 2 seconds before next account...\n`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Print Final Summary Report
    const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n===============================================================');
    console.log('📊 FINAL CRAWLER INGESTION SUMMARY REPORT');
    console.log('===============================================================');
    console.table(summary.map(s => ({
      ID: s.id,
      Account: s.username,
      Category: s.category,
      'Scraped This Run': s.scrapedCount,
      'Total Reels in DB': s.totalDbCount,
      Status: s.status,
    })));

    const grandTotalInDb = summary.reduce((acc, curr) => acc + curr.totalDbCount, 0);
    const grandTotalScraped = summary.reduce((acc, curr) => acc + curr.scrapedCount, 0);
    const successCount = summary.filter(s => s.status === 'SUCCESS').length;

    console.log(`\n📈 Grand Totals:`);
    console.log(`- Accounts Processed: ${summary.length} (${successCount} Successful, ${summary.length - successCount} Failed)`);
    console.log(`- Reels Ingested/Updated This Run: ${grandTotalScraped}`);
    console.log(`- Total Instagram Reels in Database: ${grandTotalInDb}`);
    console.log(`- Total Time Elapsed: ${totalElapsedSec}s`);
    console.log('===============================================================\n');

    process.exit(0);
  } catch (fatalErr) {
    console.error('❌ [CRAWLER] Fatal execution error:', fatalErr);
    process.exit(1);
  }
}

run();
