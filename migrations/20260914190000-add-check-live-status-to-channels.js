'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'check_live_status', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
    });
    await queryInterface.addColumn('channels', 'is_live_now', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
    });
    await queryInterface.addColumn('channels', 'upcoming_premiere_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('channels', 'upcoming_premiere_at');
    await queryInterface.removeColumn('channels', 'is_live_now');
    await queryInterface.removeColumn('channels', 'check_live_status');
  }
};
