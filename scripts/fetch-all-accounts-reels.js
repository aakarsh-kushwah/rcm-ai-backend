/**
 * @file rcm-ai-backend/scripts/fetch-all-accounts-reels.js
 * @description Unlimited Instagram profile reels ingestion runner with rate limiting and summary reporting.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const { InstagramAccount, InstagramReel } = require('../models');
const instagramService = require('../services/instagramService');
const { logger } = require('../utils/logger');

// CLI Arguments parsing
const argv = yargs(hideBin(process.argv))
  .option('only-empty', {
    type: 'boolean',
    default: false,
    description: 'Only scrape active accounts that currently have 0 reels in InstagramReel',
  })
  .option('skip-hours', {
    type: 'number',
    default: 12,
    description: 'Skip accounts whose lastSyncedAt is within the last X hours (default: 12)',
  })
  .option('force', {
    type: 'boolean',
    default: false,
    description: 'Override skip-hours and force syncing all accounts',
  })
  .option('from', {
    type: 'number',
    description: '1-based index to resume from a specific account (e.g., --from=24)',
  })
  .help()
  .alias('h', 'help')
  .argv;

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

    const whereClause = { isActive: true };

    if (argv.onlyEmpty) {
      console.log('Filtering for accounts with 0 reels (only-empty flag enabled)...');
      // This requires a subquery or a join to count reels. For simplicity and assuming
      // performance isn't critical for this script, we'll fetch all active accounts
      // and then filter in memory after counting their reels.
      // A more performant solution would involve a LEFT JOIN with InstagramReel and COUNT(*)
      // but that complicates the Sequelize query significantly.
    }

    if (!argv.force && argv.skipHours > 0) {
      const cutOffTime = new Date(Date.now() - argv.skipHours * 60 * 60 * 1000);
      console.log(`Skipping accounts synced within the last ${argv.skipHours} hours (before ${cutOffTime.toISOString()})...`);
      whereClause.lastSyncedAt = { [Op.lt]: cutOffTime };
    }

    let activeAccounts = await InstagramAccount.findAll({
      where: whereClause,
      order: [['id', 'ASC']],
    });

    if (argv.onlyEmpty) {
      const accountsWithReelCounts = await Promise.all(activeAccounts.map(async (account) => {
        const reelCount = await InstagramReel.count({ where: { accountId: account.id } });
        return { account, reelCount };
      }));
      activeAccounts = accountsWithReelCounts
        .filter(({ reelCount }) => reelCount === 0)
        .map(({ account }) => account);
      console.log(`Filtered to ${activeAccounts.length} accounts with 0 reels.`);
    }

    if (argv.from) {
      const startIndex = argv.from - 1;
      if (startIndex < 0 || startIndex >= activeAccounts.length) {
        console.log(`⚠️ --from index ${argv.from} is out of bounds. Starting from the beginning.`);
      } else {
        activeAccounts = activeAccounts.slice(startIndex);
        console.log(`Resuming from account index ${argv.from}. ${activeAccounts.length} accounts remaining.`);
      }
    }

    console.log(`📋 Found ${activeAccounts.length} active account(s) to ingest (after filtering).\n`);

    if (activeAccounts.length === 0) {
      console.log('⚠️ No active Instagram accounts found. Exiting.');
      process.exit(0);
    }

    const networkErrorTypes = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'];

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
      let attempt = 0;
      const maxAttempts = 2; // Initial attempt + 1 retry

      while (attempt < maxAttempts) {
        try {
          const syncResult = await instagramService.syncAccountReels(account.id, username);
          scrapedCount = syncResult.scrapedCount || 0;
          totalDbCount = syncResult.reelsCount || (await InstagramReel.count({ where: { accountId: account.id } }));
          status = 'SUCCESS';
          break; // Exit retry loop on success
        } catch (err) {
          errorMsg = err.message;
          console.error(`[CRAWLER] ❌ Error syncing @${username} (Attempt ${attempt + 1}/${maxAttempts}): ${err.message}`);
          logger.error({ err: err.message, username, accountId: account.id, attempt: attempt + 1 }, '[fetch-all-accounts-reels] Account sync failed');

          if (networkErrorTypes.includes(err.code) && attempt < maxAttempts - 1) {
            console.log(`[CRAWLER] ⏳ Network error detected for @${username}. Retrying in 15 seconds...`);
            await new Promise((resolve) => setTimeout(resolve, 15000));
          } else {
            status = 'FAILED';
            break; // Non-network error or max retries reached
          }
        }
        attempt++;
      }

      // After loop, if status is still not SUCCESS, it means all attempts failed
      if (status !== 'SUCCESS') {
        totalDbCount = await InstagramReel.count({ where: { accountId: account.id } });
      }

      const durationSec = ((Date.now() - accountStart) / 1000).toFixed(1);
      if (status === 'SUCCESS') {
        console.log(`[CRAWLER] ✅ Completed @${username}: Scraped ${scrapedCount} reels | DB Total: ${totalDbCount} | Duration: ${durationSec}s`);
      } else {
        console.log(`[CRAWLER] ❌ Failed to sync @${username} after ${maxAttempts} attempts. DB Total: ${totalDbCount} | Duration: ${durationSec}s`);
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
