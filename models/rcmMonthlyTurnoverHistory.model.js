'use strict';

module.exports = (sequelize, DataTypes) => {
  const RcmMonthlyTurnoverHistory = sequelize.define(
    'RcmMonthlyTurnoverHistory',
    {
      id: {
        type: DataTypes.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false
      },
      buyer_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false
      },
      year_month: {
        type: DataTypes.STRING(7),
        allowNull: false
      },
      self_pv: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
      },
      leg_a_pv: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
      },
      leg_b_pv: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
      },
      total_group_pv: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
      },
      growth_percentage: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        defaultValue: 0.00
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
      }
    },
    {
      tableName: 'rcm_monthly_turnover_history',
      timestamps: false,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
      indexes: [
        {
          unique: true,
          name: 'uniq_buyer_year_month',
          fields: ['buyer_id', 'year_month']
        }
      ]
    }
  );

  return RcmMonthlyTurnoverHistory;
};
