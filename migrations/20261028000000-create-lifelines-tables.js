'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('rcm_identities', {
      buyer_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        allowNull: false
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      },
      phone: {
        type: Sequelize.STRING(20),
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      },
      address: {
        type: Sequelize.TEXT,
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      },
      highest_pin: {
        type: Sequelize.STRING(50),
        allowNull: true,
        defaultValue: 'ASSOCIATE BUYER',
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      },
      profile_photo_url: {
        type: Sequelize.STRING(500),
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci'
    });

    await queryInterface.createTable('rcm_downline_nodes', {
      buyer_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        allowNull: false
      },
      upline_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      },
      status: {
        type: Sequelize.TINYINT(1),
        allowNull: false,
        defaultValue: 1,
        comment: '1 = ACTIVE, 0 = TERMINATED'
      },
      kyc_status: {
        type: Sequelize.STRING(50),
        allowNull: false,
        defaultValue: 'KYC OK',
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci'
      },
      purchase_amt: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
      },
      pv: {
        type: Sequelize.MEDIUMINT.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      },
      depth_level: {
        type: Sequelize.SMALLINT.UNSIGNED,
        allowNull: false,
        defaultValue: 1
      },
      lineage: {
        type: Sequelize.STRING(1000),
        allowNull: true,
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        comment: 'Ancestor chain e.g. /ROOT/UPLINE/BUYER_ID/'
      },
      last_synced_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci'
    });

    await queryInterface.addIndex('rcm_downline_nodes', ['upline_id', 'depth_level'], {
      name: 'idx_upline_depth'
    });
    await queryInterface.addIndex('rcm_downline_nodes', ['name', 'status'], {
      name: 'idx_name_status'
    });
    await queryInterface.addIndex('rcm_downline_nodes', ['pv'], {
      name: 'idx_pv'
    });
    await queryInterface.addIndex('rcm_downline_nodes', ['status'], {
      name: 'idx_status'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('rcm_downline_nodes');
    await queryInterface.dropTable('rcm_identities');
  }
};
