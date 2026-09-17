'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('channel_videos');
    if (!tableInfo['is_available']) {
      await queryInterface.addColumn('channel_videos', 'is_available', {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
        allowNull: false
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('channel_videos');
    if (tableInfo['is_available']) {
      await queryInterface.removeColumn('channel_videos', 'is_available');
    }
  }
};
