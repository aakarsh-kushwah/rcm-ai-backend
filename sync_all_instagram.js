// sync_all_instagram.js
const { sequelize, InstagramAccount, InstagramReel } = require('./models');
const { QueryTypes } = require('sequelize');
const { fetchFullProfileReels } = require('./services/fullProfileReelsScraper');
const { fetchProfileReels } = require('./services/instagramScraper');

async function runBulkSync() {
  try {
    console.log('🚀 Starting Bulk Instagram Accounts Sync & Scraper...');
    
    // Inspect reels table for foreign key column
    const columns = await sequelize.query('DESCRIBE instagram_reels', { type: QueryTypes.SELECT });
    const columnNames = columns.map(c => c.Field);
    const fkColumn = columnNames.includes('account_id') ? 'account_id' : 'instagram_account_id';
    console.log(`📌 Using foreign key column: "${fkColumn}"`);

    // Fetch all active Instagram accounts from TiDB
    const accounts = await InstagramAccount.findAll({
      where: { isActive: true }
    });

    console.log(`📋 Found ${accounts.length} active Instagram accounts to sync.\n`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const username = acc.username || acc.handle;
      if (!username) {
        console.log(`[${i + 1}/${accounts.length}] Skipping account ID ${acc.id} due to missing username.`);
        continue;
      }

      console.log(`--------------------------------------------------`);
      console.log(`[${i + 1}/${accounts.length}] Processing @${username} (ID: ${acc.id})`);

      try {
        let rawReels = [];
        try {
          rawReels = await fetchFullProfileReels(username, { accountId: acc.id, category: acc.category || 'General' });
        } catch (err) {
          console.log(`  ⚠️ Primary scraper failed, trying fallback for @${username}...`);
          rawReels = await fetchProfileReels(username, { accountId: acc.id, category: acc.category || 'General' });
        }

        const reelsArray = Array.isArray(rawReels) ? rawReels : (rawReels?.reels || rawReels?.items || []);
        console.log(`  📥 Fetched ${reelsArray.length} raw reels from scraper.`);

        let savedNew = 0;
        for (const reel of reelsArray) {
          const shortcode = reel.shortcode || reel.code || reel.shortCode;
          if (!shortcode) continue;

          const existing = await InstagramReel.findOne({ where: { shortcode: String(shortcode) } });
          if (!existing) {
            await InstagramReel.create({
              [fkColumn]: acc.id,
              accountId: acc.id,
              creatorHandle: username,
              shortcode: String(shortcode),
              caption: reel.caption || reel.title || '',
              title: reel.title || reel.caption || '',
              videoUrl: reel.videoUrl || reel.directVideo || reel.mediaUrl || reel.video_url || null,
              thumbnailUrl: reel.thumbnailUrl || reel.displayUrl || reel.thumb || reel.thumbnail_url || null,
              likesCount: Number(reel.likesCount || reel.likes || 0),
              commentsCount: Number(reel.commentsCount || reel.comments || 0),
              viewCount: Number(reel.viewCount || reel.views || 0),
              duration: Number(reel.duration || 0),
              publishedAt: reel.publishedAt ? new Date(reel.publishedAt) : new Date(),
              isAvailable: true
            });
            savedNew++;
          }
        }

        // Recalculate true count from database and update account counts
        const trueCount = await InstagramReel.count({ where: { [fkColumn]: acc.id } });
        
        await acc.update({
          reelsCount: trueCount,
          reelCount: trueCount,
          videoCount: trueCount,
          lastSyncedAt: new Date(),
          lastSyncStatus: 'SUCCESS',
          lastSyncError: null
        }).catch(async () => {
          await sequelize.query(`
            UPDATE instagram_accounts 
            SET video_count = ${trueCount}, reels_count = ${trueCount}, reelCount = ${trueCount}, last_synced_at = NOW()
            WHERE id = ${acc.id}
          `).catch(() => {});
        });

        console.log(`  ✅ Success! Saved ${savedNew} new reels. Total in DB: ${trueCount}`);
        successCount++;
      } catch (error) {
        console.error(`  ❌ Failed syncing @${username}:`, error.message);
        failCount++;
      }
    }

    console.log(`\n==================================================`);
    console.log(`✨ Bulk Sync Finished! Succeeded: ${successCount}, Failed: ${failCount}`);
    console.log(`==================================================`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Fatal error in bulk sync runner:', err);
    process.exit(1);
  }
}

runBulkSync();