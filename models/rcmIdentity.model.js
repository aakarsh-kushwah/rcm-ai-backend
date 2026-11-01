'use strict';

module.exports = (sequelize, DataTypes) => {
  const RcmIdentity = sequelize.define(
    'RcmIdentity',
    {
      buyer_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        primaryKey: true,
        allowNull: false
      },
      lineage: {
        type: DataTypes.STRING(1000),
        allowNull: true,
        comment: 'Ancestor chain for scoped territory views'
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false
      },
      phone: {
        type: DataTypes.STRING(20),
        allowNull: true
      },
      mobile_no: {
        type: DataTypes.STRING(20),
        allowNull: true
      },
      custom_photo_url: {
        type: DataTypes.STRING(500),
        allowNull: true,
        defaultValue: null
      },
      address: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      state: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: null
      },
      district: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: null
      },
      city: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: null
      },
      post_village: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: null
      },
      tehsil: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: null
      },
      pincode: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: null
      },
      sponsor_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: null
      },
      sponsor_name: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: null
      },
      proposer_id: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: null
      },
      proposer_name: {
        type: DataTypes.STRING(100),
        allowNull: true,
        defaultValue: null
      },
      highest_pin: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: 'ASSOCIATE BUYER'
      },
      join_date: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null
      },
      kyc_status: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: 'KYC OK'
      },
      profile_photo_url: {
        type: DataTypes.STRING(500),
        allowNull: true
      },
      network_summary: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
      }
    },
    {
      tableName: 'rcm_identities',
      timestamps: false,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
      indexes: [
        {
          unique: false,
          name: 'idx_identity_name',
          fields: ['name']
        },
        {
          unique: false,
          name: 'idx_identity_lineage_state_district_post',
          fields: [
            { name: 'lineage', length: 50 },
            'state',
            'district',
            'post_village'
          ]
        }
      ]
    }
  );

  return RcmIdentity;
};
