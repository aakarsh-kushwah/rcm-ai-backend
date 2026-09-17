'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('channel_videos', 'live_broadcast_content', {
      type: Sequelize.STRING(20),
      allowNull: true,
    });
    await queryInterface.addColumn('channel_videos', 'scheduled_start_time', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('channel_videos', 'live_broadcast_content');
    await queryInterface.removeColumn('channel_videos', 'scheduled_start_time');
  },
};