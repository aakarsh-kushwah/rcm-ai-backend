'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (!table) {
      throw new Error('rcm_identities table does not exist.');
    }

    if (!table.custom_photo_url) {
      await queryInterface.addColumn('rcm_identities', 'custom_photo_url', {
        type: Sequelize.STRING(500),
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        defaultValue: null
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (table && table.custom_photo_url) {
      await queryInterface.removeColumn('rcm_identities', 'custom_photo_url');
    }
  }
};
