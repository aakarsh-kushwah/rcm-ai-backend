
const { connectDB } = require('../config/db');
const { syncAllActiveChannels } = require('../services/channelSyncService');
const logger = require('../utils/logger');

async function runManualSync() {
    try {
        await connectDB(); // Establish DB connection
        logger.info('Manually triggering full channel sync...');
        await syncAllActiveChannels();
        logger.info('Manual channel sync completed.');
    } catch (error) {
        logger.error(`Error during manual channel sync: ${error.message}`);
        process.exit(1);
    } finally {
        // Sequelize closes its connection automatically after a short idle period
        // if not explicitly called. For a script like this, it's fine.
    }
}

runManualSync();
