'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn(
      'Users', // table name
      'razorpaySubscriptionId', // new field name
      {
        type: Sequelize.STRING,
        allowNull: true, // or false, depending on your business logic
      }
    );
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn(
      'Users',
      'razorpaySubscriptionId'
    );
  }
};
