'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (!table) {
      throw new Error('rcm_identities table does not exist.');
    }

    if (!table.tehsil) {
      await queryInterface.addColumn('rcm_identities', 'tehsil', {
        type: Sequelize.STRING(100),
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        defaultValue: null
      });
    }

    if (!table.post_village) {
      await queryInterface.addColumn('rcm_identities', 'post_village', {
        type: Sequelize.STRING(150),
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        defaultValue: null
      });
    }

    if (!table.pincode) {
      await queryInterface.addColumn('rcm_identities', 'pincode', {
        type: Sequelize.STRING(10),
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        defaultValue: null
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (table) {
      if (table.tehsil) {
        await queryInterface.removeColumn('rcm_identities', 'tehsil');
      }
      if (table.post_village) {
        await queryInterface.removeColumn('rcm_identities', 'post_village');
      }
      if (table.pincode) {
        await queryInterface.removeColumn('rcm_identities', 'pincode');
      }
    }
  }
};
