'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'upcoming_video_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'scheduled_start_time', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'discovered_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'is_currently_live', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
    });
    await queryInterface.addColumn('channels', 'live_video_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'live_started_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'last_live_check_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'last_notified_video_id', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('channels', 'last_notified_video_id');
    await queryInterface.removeColumn('channels', 'last_live_check_at');
    await queryInterface.removeColumn('channels', 'live_started_at');
    await queryInterface.removeColumn('channels', 'live_video_id');
    await queryInterface.removeColumn('channels', 'is_currently_live');
    await queryInterface.removeColumn('channels', 'discovered_at');
    await queryInterface.removeColumn('channels', 'scheduled_start_time');
    await queryInterface.removeColumn('channels', 'upcoming_video_id');
  }
};
