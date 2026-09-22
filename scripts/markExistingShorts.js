const { Channel, ChannelVideo, sequelize } = require('../models');

async function backfill() {
  try {
    // 1. Mark hashtag shorts
    await sequelize.query(
      "UPDATE channel_videos SET is_short = true WHERE is_short = false AND (LOWER(title) LIKE '%#shorts%' OR LOWER(title) LIKE '%#short%');"
    );
    console.log('✅ Backfilled hashtag shorts successfully.');

    // 2. Mark shorts-only channel videos as is_short = true
    const shortsOnlyChannels = await Channel.findAll({ where: { isShortsOnly: true } });
    for (const ch of shortsOnlyChannels) {
      await ChannelVideo.update({ isShort: true }, { where: { channelId: ch.id } });
      console.log(`✅ Marked all videos of shorts-only channel "${ch.name}" as shorts.`);
    }

    // 3. Recalculate shorts_count for all channels
    const channels = await Channel.findAll();
    for (const ch of channels) {
      const shortsCount = await ChannelVideo.count({ where: { channelId: ch.id, isShort: true } });
      ch.shortsCount = shortsCount;
      await ch.save();
    }
    console.log('📊 Recalculated shorts counts for all channels.');

    const totalShorts = await ChannelVideo.count({ where: { is_short: true } });
    const totalLong = await ChannelVideo.count({ where: { is_short: false } });
    console.log(`📊 DB Summary: Total Shorts = ${totalShorts}, Total Long Videos = ${totalLong}`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Backfill Error:', err.message);
    process.exit(1);
  }
}

backfill();
