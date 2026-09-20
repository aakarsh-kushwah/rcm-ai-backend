const { ChannelVideo, sequelize } = require('../models');

async function backfill() {
  try {
    const [result] = await sequelize.query(
      "UPDATE channel_videos SET is_short = true WHERE is_short = false AND (LOWER(title) LIKE '%#shorts%' OR LOWER(title) LIKE '%#short%');"
    );
    console.log('✅ Backfilled hashtag shorts successfully.');

    const totalShorts = await ChannelVideo.count({ where: { is_short: true } });
    console.log('📊 Total active shorts ready in DB:', totalShorts);
    process.exit(0);
  } catch (err) {
    console.error('❌ Backfill Error:', err.message);
    process.exit(1);
  }
}

backfill();
