const { queryInterface } = require('../models').sequelize;
const logger = require('../utils/logger');

async function applyManualChannelMigrations() {
  logger.info('Applying manual channel metadata migrations...');
  try {
    // Add view_count
    await queryInterface.addColumn('channels', 'view_count', {
      type: 'BIGINT',
      defaultValue: 0,
      allowNull: false,
    }).catch(err => {
      if (!err.message.includes("Duplicate column name 'view_count'")) {
        throw err;
      } else {
        logger.warn('Column view_count already exists, skipping.');
      }
    });

    // Add joined_date
    await queryInterface.addColumn('channels', 'joined_date', {
      type: 'DATETIME',
      allowNull: true,
    }).catch(err => {
      if (!err.message.includes("Duplicate column name 'joined_date'")) {
        throw err;
      } else {
        logger.warn('Column joined_date already exists, skipping.');
      }
    });

    // Add country
    await queryInterface.addColumn('channels', 'country', {
      type: 'VARCHAR(10)',
      allowNull: true,
    }).catch(err => {
      if (!err.message.includes("Duplicate column name 'country'")) {
        throw err;
      } else {
        logger.warn('Column country already exists, skipping.');
      }
    });

    logger.info('Manual channel metadata migrations applied successfully (or already existed).');
  } catch (err) {
    logger.error(`Error applying manual channel metadata migrations: ${err.message}`);
    process.exit(1);
  }
}

async function applyManualMigrationForBannerSubscriberVideoDescription() {
  logger.info('Applying manual channel banner, subscriber, video count, description migrations...');
  try {
    await queryInterface.addColumn('channels', 'banner_url', {
      type: 'VARCHAR(500)',
      allowNull: true,
    }).catch(err => {
      if (!err.message.includes("Duplicate column name 'banner_url'")) {
        throw err;
      } else {
        logger.warn('Column banner_url already exists, skipping.');
      }
    });

    await queryInterface.addColumn('channels', 'subscriber_count', {
      type: 'BIGINT',
      defaultValue: 0,
      allowNull: false,
    }).catch(err => {
      if (!err.message.includes("Duplicate column name 'subscriber_count'")) {
        throw err;
      } else {
        logger.warn('Column subscriber_count already exists, skipping.');
      }
    });

    await queryInterface.addColumn('channels', 'video_count', {
      type: 'BIGINT',
      defaultValue: 0,
      allowNull: false,
    }).catch(err => {
      if (!err.message.includes("Duplicate column name 'video_count'")) {
        throw err;
      } else {
        logger.warn('Column video_count already exists, skipping.');
      }
    });

    await queryInterface.addColumn('channels', 'description', {
      type: 'TEXT',
      allowNull: true,
    }).catch(err => {
      if (!err.message.includes("Duplicate column name 'description'")) {
        throw err;
      } else {
        logger.warn('Column description already exists, skipping.');
      }
    });

    logger.info('Manual channel banner, subscriber, video count, description migrations applied successfully (or already existed).');
  } catch (err) {
    logger.error(`Error applying manual channel banner, subscriber, video count, description migrations: ${err.message}`);
    process.exit(1);
  }
}

async function runAllManualMigrations() {
  await applyManualMigrationForBannerSubscriberVideoDescription();
  await applyManualChannelMigrations();
  logger.info('All manual migrations attempted.');
  process.exit(0);
}

if (require.main === module) {
  runAllManualMigrations();
}
