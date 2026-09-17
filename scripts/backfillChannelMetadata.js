const { Channel } = require('../models');
const { refreshChannelMetadata } = require('../services/channelSyncService');
const logger = require('../utils/logger');

async function backfillChannelMetadata() {
  logger.info('Starting one-time backfill for channel metadata and statistics...');
  try {
    const channels = await Channel.findAll();
    let updatedCount = 0;

    for (const channel of channels) {
      try {
        await refreshChannelMetadata(channel);
        updatedCount++;
      } catch (err) {
        logger.error(`Failed to backfill metadata for channel ${channel.name} (ID: ${channel.id}): ${err.message}`);
      }
    }

    logger.info(`Backfill completed. ${updatedCount} channels updated with metadata and statistics.`);
  } catch (err) {
    logger.error(`Error in backfillChannelMetadata: ${err.message}`);
  }
  process.exit(0);
}

if (require.main === module) {
  backfillChannelMetadata();
}
