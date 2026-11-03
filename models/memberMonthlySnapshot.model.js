'use strict';

module.exports = (sequelize, DataTypes) => {
  const MemberMonthlySnapshot = sequelize.define(
    'MemberMonthlySnapshot',
    {
      buyer_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        primaryKey: true,
      },
      month_key: {
        type: DataTypes.STRING(7),
        allowNull: false,
        primaryKey: true,
      },
      pv: {
        type: DataTypes.MEDIUMINT.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      purchase_amt: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
      },
      leg_type: {
        type: DataTypes.STRING(10),
        allowNull: true,
        defaultValue: 'A',
      },
      status: {
        type: DataTypes.TINYINT(1),
        allowNull: false,
        defaultValue: 1,
      },
      total_group_pv: {
        type: DataTypes.MEDIUMINT.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      repurchase_amt: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
      },
    },
    {
      tableName: 'rcm_member_monthly_snapshots',
      timestamps: false,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
      indexes: [
        { name: 'idx_member_snapshot_month', fields: ['month_key'] },
        { name: 'idx_member_snapshot_leg', fields: ['leg_type'] },
      ],
    }
  );

  return MemberMonthlySnapshot;
};
