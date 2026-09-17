'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('channels', 'banner_url', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'subscriber_count', {
      type: Sequelize.BIGINT,
      defaultValue: 0,
    });
    await queryInterface.addColumn('channels', 'video_count', {
      type: Sequelize.BIGINT,
      defaultValue: 0,
    });
    await queryInterface.addColumn('channels', 'description', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('channels', 'banner_url');
    await queryInterface.removeColumn('channels', 'subscriber_count');
    await queryInterface.removeColumn('channels', 'video_count');
    await queryInterface.removeColumn('channels', 'description');
  },
};