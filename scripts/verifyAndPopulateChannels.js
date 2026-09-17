const { Channel } = require('../models');
const { refreshChannelMetadata } = require('../services/channelSyncService');
const logger = require('../utils/logger');
const { sequelize } = require('../config/db');

async function verifyAndPopulateChannels() {
  console.log('=== Step 1: Verifying and Populating TiDB Channels Table ===');
  try {
    await sequelize.authenticate();
    // 1. Inspect channels table with correct physical columns
    const [results] = await sequelize.query(
      'SELECT id, name, handle, subscriber_count, video_count, view_count, description FROM channels;'
    );
    console.log('Inspection results from channels table:', results);

    // 2. Fetch and populate metadata for all channels
    const channels = await Channel.findAll();
    console.log(`Found ${channels.length} channels in database. Refreshing metadata via YouTube Data API v3...`);

    for (const channel of channels) {
      try {
        console.log(`Refreshing metadata for channel ID ${channel.id} (${channel.name}, handle: ${channel.handle}, youtubeId: ${channel.youtubeChannelId})...`);
        await refreshChannelMetadata(channel);
        await channel.reload();
        console.log(`Updated Channel Record:`, {
          id: channel.id,
          name: channel.name,
          handle: channel.handle,
          subscriberCount: channel.subscriberCount,
          videoCount: channel.videoCount,
          viewCount: channel.viewCount,
          description: channel.description ? channel.description.substring(0, 60) + '...' : '(empty)'
        });
      } catch (err) {
        console.error(`Failed to update channel ${channel.name}: ${err.message}`);
      }
    }

    console.log('=== Verification and Population Completed Successfully ===');
  } catch (err) {
    console.error('Error in verifyAndPopulateChannels:', err);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
}

if (require.main === module) {
  verifyAndPopulateChannels();
}
