// sync_zero.js
const { sequelize } = require('./models');
const { QueryTypes } = require('sequelize');
const InstagramAccount = require('./models/InstagramAccount');
const InstagramReel = require('./models/InstagramReel');
const { fetchFullProfileReels } = require('./services/fullProfileReelsScraper');
const { fetchProfileReels } = require('./services/instagramScraper');

async function syncZeroVideoAccounts() {
  try {
    console.log('Inspecting instagram_reels table structure...');
    const columns = await sequelize.query('DESCRIBE instagram_reels', { type: QueryTypes.SELECT });
    const columnNames = columns.map(c => c.Field);
    const fkColumn = columnNames.includes('account_id') ? 'account_id' : 'instagram_account_id';

    console.log('\nFetching Instagram accounts with 0 videos...');
    const accounts = await sequelize.query(`
      SELECT ia.id, ia.username, ia.category
      FROM instagram_accounts ia
      WHERE NOT EXISTS (
        SELECT 1 FROM instagram_reels ir WHERE ir.${fkColumn} = ia.id
      )
    `, { type: QueryTypes.SELECT });

    console.log(`\nTotal accounts with 0 videos found: ${accounts.length}`);
    console.log('Starting direct scraping and saving process...\n');

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const username = acc.username;
      console.log(`[${i + 1}/${accounts.length}] Scraping account: @${username} (ID: ${acc.id})`);

      try {
        let rawReels = [];
        try {
          rawReels = await fetchFullProfileReels(username, { accountId: acc.id, category: acc.category || 'General' });
        } catch (e) {
          console.log(`  -> Fallback scraper for @${username}...`);
          rawReels = await fetchProfileReels(username, { accountId: acc.id, category: acc.category || 'General' });
        }

        const reelsArray = Array.isArray(rawReels) ? rawReels : (rawReels?.reels || rawReels?.items || []);
        console.log(`  -> Fetched ${reelsArray.length} raw reels from internet.`);

        let savedCount = 0;
        for (const reel of reelsArray) {
          const shortcode = reel.shortcode || reel.code || reel.shortCode;
          if (!shortcode) continue;

          // Check if reel already exists
          const existing = await InstagramReel.findOne({ where: { shortcode } });
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
            savedCount++;
          }
        }

        // Update account video count fields
        await sequelize.query(`
          UPDATE instagram_accounts 
          SET video_count = (SELECT COUNT(*) FROM instagram_reels WHERE ${fkColumn} = ${acc.id}),
              reels_count = (SELECT COUNT(*) FROM instagram_reels WHERE ${fkColumn} = ${acc.id}),
              reelCount = (SELECT COUNT(*) FROM instagram_reels WHERE ${fkColumn} = ${acc.id})
          WHERE id = ${acc.id}
        `).catch(() => {});

        console.log(`✅ Successfully saved ${savedCount} new reels for @${username}`);
      } catch (err) {
        console.error(`❌ Failed to process @${username}:`, err.message);
      }
    }

    console.log('\n✨ All zero-video accounts synced and saved successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error during sync script:', error);
    process.exit(1);
  }
}

syncZeroVideoAccounts();