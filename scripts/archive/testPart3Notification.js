const { Channel, sequelize } = require('../models');
const { liveEmitter } = require('../services/channelSyncService');
const logger = require('../utils/logger');

async function testNotificationTrigger() {
  try {
    await sequelize.authenticate();
    logger.info('Database connected for Part 3 notification test.');

    const channel = await Channel.findOne({ where: { isActive: true } });
    if (!channel) {
      logger.warn('No active channel found for testing.');
      process.exit(0);
    }

    logger.info(`Triggering upcomingToLive event for channel: ${channel.name}`);
    liveEmitter.emit('upcomingToLive', {
      channel,
      videoId: 'TEST_VIDEO_123',
      scheduledStartTime: new Date(),
      liveStartedAt: new Date()
    });

    // Wait 2 seconds for event handler to run
    await new Promise(resolve => setTimeout(resolve, 2000));
    logger.info('Part 3 test executed successfully.');
    process.exit(0);
  } catch (err) {
    logger.error(`Part 3 test failed: ${err.message}`);
    process.exit(1);
  }
}

testNotificationTrigger();
