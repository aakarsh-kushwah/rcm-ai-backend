'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('channels', 'view_count', {
      type: Sequelize.BIGINT,
      defaultValue: 0,
    });
    await queryInterface.addColumn('channels', 'joined_date', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('channels', 'country', {
      type: Sequelize.STRING(10),
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('channels', 'view_count');
    await queryInterface.removeColumn('channels', 'joined_date');
    await queryInterface.removeColumn('channels', 'country');
  },
};
