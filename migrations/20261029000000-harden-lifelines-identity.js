'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (!tableInfo) {
      throw new Error('rcm_identities table does not exist. Run the Lifelines base migration first.');
    }

    const columnsToAdd = [
      ['lineage', { type: Sequelize.STRING(1000), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci', comment: 'Ancestor chain for scoped territory views' }],
      ['state', { type: Sequelize.STRING(100), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['district', { type: Sequelize.STRING(100), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['city', { type: Sequelize.STRING(100), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['post_village', { type: Sequelize.STRING(100), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['tehsil', { type: Sequelize.STRING(100), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['pincode', { type: Sequelize.STRING(20), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['mobile_no', { type: Sequelize.STRING(20), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['sponsor_id', { type: Sequelize.INTEGER.UNSIGNED, allowNull: true }],
      ['sponsor_name', { type: Sequelize.STRING(100), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['proposer_id', { type: Sequelize.INTEGER.UNSIGNED, allowNull: true }],
      ['proposer_name', { type: Sequelize.STRING(100), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['custom_photo_url', { type: Sequelize.STRING(500), allowNull: true, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['join_date', { type: Sequelize.DATE, allowNull: true }],
      ['kyc_status', { type: Sequelize.STRING(50), allowNull: true, defaultValue: 'KYC OK', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }],
      ['network_summary', { type: Sequelize.JSON, allowNull: true, defaultValue: null }],
    ];

    for (const [columnName, definition] of columnsToAdd) {
      if (!tableInfo[columnName]) {
        await queryInterface.addColumn('rcm_identities', columnName, definition);
      }
    }

    const indexes = await queryInterface.showIndex('rcm_identities');
    const hasCompoundIndex = indexes.some((index) => index.name === 'idx_identity_lineage_state_district_post');
    if (!hasCompoundIndex) {
      await queryInterface.addIndex('rcm_identities', [
        { attribute: 'lineage', length: 50 },
        'state',
        'district',
        'post_village'
      ], {
        name: 'idx_identity_lineage_state_district_post'
      });
    }

    const turnoverTableExists = await queryInterface.showAllTables().then((tables) => tables.includes('rcm_monthly_turnover_history'));
    if (!turnoverTableExists) {
      await queryInterface.createTable('rcm_monthly_turnover_history', {
        id: {
          type: Sequelize.INTEGER.UNSIGNED,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false
        },
        buyer_id: {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: false
        },
        year_month: {
          type: Sequelize.STRING(7),
          allowNull: false,
          charset: 'utf8mb4',
          collate: 'utf8mb4_unicode_ci'
        },
        self_pv: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0.00
        },
        leg_a_pv: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0.00
        },
        leg_b_pv: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0.00
        },
        total_group_pv: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: false,
          defaultValue: 0.00
        },
        growth_percentage: {
          type: Sequelize.DECIMAL(10, 2),
          allowNull: true,
          defaultValue: 0.00
        },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        indexes: [
          {
            unique: true,
            name: 'uniq_buyer_year_month',
            fields: ['buyer_id', 'year_month']
          }
        ]
      });
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('rcm_monthly_turnover_history')) {
      await queryInterface.dropTable('rcm_monthly_turnover_history');
    }

    const columns = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (columns) {
      const dropList = ['lineage', 'state', 'district', 'city', 'post_village', 'pincode', 'mobile_no', 'join_date', 'kyc_status', 'network_summary'];
      for (const columnName of dropList) {
        if (columns[columnName]) {
          await queryInterface.removeColumn('rcm_identities', columnName);
        }
      }
    }
  }
};
