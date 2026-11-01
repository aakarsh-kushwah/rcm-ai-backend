'use strict';

module.exports = (sequelize, DataTypes) => {
  const DownlineNode = sequelize.define(
    'DownlineNode',
    {
      buyer_id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        allowNull: false
      },
      parent_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        references: {
          model: 'rcm_downline_nodes',
          key: 'buyer_id'
        }
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false
      },
      current_pv: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
      },
      purchase_amt: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
      },
      status: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '1 = ACTIVE, 0 = TERMINATED'
      },
      level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      children_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
    },
    {
      tableName: 'rcm_downline_nodes',
      timestamps: false,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
      indexes: [
        {
          name: 'idx_parent_id',
          fields: ['parent_id']
        },
        {
          name: 'idx_name_status',
          fields: ['name', 'status']
        },
        {
          name: 'idx_current_pv',
          fields: ['current_pv']
        },
        {
          name: 'idx_status',
          fields: ['status']
        },
        {
          name: 'idx_level',
          fields: ['level']
        }
      ]
    }
  );

  return DownlineNode;
};
