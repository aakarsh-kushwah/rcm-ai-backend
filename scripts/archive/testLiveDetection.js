const { Channel, sequelize } = require('../models');
const { checkLiveAndUpcomingStatus, getVideoLiveStatus, liveEmitter } = require('../services/channelSyncService');
const logger = require('../utils/logger');

async function runTest() {
  try {
    await sequelize.authenticate();
    logger.info('Database connection established successfully for live detection test.');

    // Listen to upcoming -> live transition event
    liveEmitter.on('upcomingToLive', (data) => {
      logger.info(`[Test Event Listener] Received upcomingToLive event for channel: ${data.channel.name}, videoId: ${data.videoId}`);
    });

    logger.info('Testing checkLiveAndUpcomingStatus execution...');
    await checkLiveAndUpcomingStatus();
    logger.info('Live detection test executed successfully without crashing.');
    process.exit(0);
  } catch (err) {
    logger.error(`Live detection test failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

runTest();
