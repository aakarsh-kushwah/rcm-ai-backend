'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('rcm_member_monthly_snapshots', {
      buyer_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        primaryKey: true,
      },
      month_key: {
        type: Sequelize.STRING(7),
        allowNull: false,
        primaryKey: true,
      },
      pv: {
        type: Sequelize.MEDIUMINT.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      purchase_amt: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
      },
      leg_type: {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'A',
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      },
      status: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 1,
      },
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    });

    await queryInterface.addIndex('rcm_member_monthly_snapshots', ['month_key'], { name: 'idx_member_snapshot_month' });
    await queryInterface.addIndex('rcm_member_monthly_snapshots', ['leg_type'], { name: 'idx_member_snapshot_leg' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('rcm_member_monthly_snapshots');
  },
};
