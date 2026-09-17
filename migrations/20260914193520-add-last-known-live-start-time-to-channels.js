module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'last_known_live_start_time', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('channels', 'last_known_live_start_time');
  }
};
