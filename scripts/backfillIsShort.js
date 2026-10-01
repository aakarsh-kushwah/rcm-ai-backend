/**
 * @file rcm-ai-backend/scripts/backfillIsShort.js
 * @description Standalone script to backfill isShort status for existing ChannelVideo rows where isShort IS NULL.
 * Usage: node scripts/backfillIsShort.js [--dry-run]
 */

require('dotenv').config();
const axios = require('axios');
const { ChannelVideo, sequelize } = require('../models');

async function backfillIsShort() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');

  console.log(`[Backfill] Starting isShort backfill script. Mode: ${isDryRun ? 'DRY RUN' : 'LIVE UPDATE'}`);

  try {
    // Fetch rows where isShort IS NULL
    const videos = await ChannelVideo.findAll({
      where: {
        isShort: null,
      },
    });

    console.log(`[Backfill] Found ${videos.length} videos with isShort IS NULL.`);

    let shortCount = 0;
    let longCount = 0;
    let failedVideos = [];
    let updatedCount = 0;

    const batchSize = 50;

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const videoId = video.youtubeVideoId;

      try {
        const shortUrl = `https://www.youtube.com/shorts/${videoId}`;
        const res = await axios.get(shortUrl, {
          maxRedirects: 0,
          validateStatus: status => status >= 200 && status < 400,
          timeout: 5000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        let isShort = false;
        if (res.status === 200) {
          isShort = true;
        } else if (res.status === 301 || res.status === 302) {
          const location = res.headers.location || '';
          if (location.includes('/watch')) {
            isShort = false;
          } else {
            isShort = true;
          }
        }

        if (isShort) {
          shortCount++;
        } else {
          longCount++;
        }

        if (!isDryRun) {
          video.isShort = isShort;
          await video.save();
          updatedCount++;
        }

        if ((i + 1) % batchSize === 0 || i === videos.length - 1) {
          console.log(`[Backfill] Progress: ${i + 1}/${videos.length} processed. (Shorts: ${shortCount}, Long: ${longCount})`);
        }
      } catch (err) {
        if (err.response && (err.response.status === 301 || err.response.status === 302)) {
          const location = err.response.headers.location || '';
          const isShort = !location.includes('/watch');
          if (isShort) shortCount++; else longCount++;

          if (!isDryRun) {
            video.isShort = isShort;
            await video.save();
            updatedCount++;
          }
        } else {
          console.warn(`[Backfill] Error checking video ${videoId}: ${err.message}`);
          failedVideos.push(videoId);
        }
      }

      // Rate limit: 200-300ms delay between requests
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    console.log('\n========================================');
    console.log(`[Backfill] Completed!`);
    console.log(`- Total processed: ${videos.length}`);
    console.log(`- Detected Shorts: ${shortCount}`);
    console.log(`- Detected Long videos: ${longCount}`);
    console.log(`- Failed checks: ${failedVideos.length}`);
    if (!isDryRun) {
      console.log(`- Successfully updated in DB: ${updatedCount}`);
    }
    if (failedVideos.length > 0) {
      console.log(`- Failed videoIds:`, failedVideos);
    }
    console.log('========================================');

    process.exit(0);
  } catch (err) {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
  }
}

backfillIsShort();
