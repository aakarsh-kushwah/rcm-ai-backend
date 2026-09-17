'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('channels');
    if (!tableInfo['last_known_live_start_time']) {
      await queryInterface.addColumn('channels', 'last_known_live_start_time', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },

  async down (queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('channels');
    if (tableInfo['last_known_live_start_time']) {
      await queryInterface.removeColumn('channels', 'last_known_live_start_time');
    }
  }
};
