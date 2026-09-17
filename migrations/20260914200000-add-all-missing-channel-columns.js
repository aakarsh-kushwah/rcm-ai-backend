'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('channels');
    
    const addColIfNotExists = async (colName, colDefinition) => {
      if (!tableInfo[colName]) {
        await queryInterface.addColumn('channels', colName, colDefinition);
      }
    };

    await addColIfNotExists('last_sync_status', { type: Sequelize.STRING(20), defaultValue: 'ok' });
    await addColIfNotExists('last_sync_error', { type: Sequelize.TEXT, allowNull: true });
    await addColIfNotExists('check_live_status', { type: Sequelize.BOOLEAN, defaultValue: false });
    await addColIfNotExists('is_live_now', { type: Sequelize.BOOLEAN, defaultValue: false });
    await addColIfNotExists('upcoming_premiere_at', { type: Sequelize.DATE, allowNull: true });
    await addColIfNotExists('upcoming_video_id', { type: Sequelize.STRING(100), allowNull: true });
    await addColIfNotExists('scheduled_start_time', { type: Sequelize.DATE, allowNull: true });
    await addColIfNotExists('discovered_at', { type: Sequelize.DATE, allowNull: true });
    await addColIfNotExists('is_currently_live', { type: Sequelize.BOOLEAN, defaultValue: false });
    await addColIfNotExists('live_video_id', { type: Sequelize.STRING(100), allowNull: true });
    await addColIfNotExists('live_started_at', { type: Sequelize.DATE, allowNull: true });
    await addColIfNotExists('last_live_check_at', { type: Sequelize.DATE, allowNull: true });
    await addColIfNotExists('last_notified_video_id', { type: Sequelize.STRING(100), allowNull: true });
  },

  async down(queryInterface, Sequelize) {
    // No-op for down
  }
};
