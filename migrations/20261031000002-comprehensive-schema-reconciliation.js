'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Reconcile rcm_identities
    const identityTable = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (identityTable) {
      if (!identityTable.sponsor_id) {
        await queryInterface.addColumn('rcm_identities', 'sponsor_id', {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          defaultValue: null
        });
      }
      if (!identityTable.proposer_id) {
        await queryInterface.addColumn('rcm_identities', 'proposer_id', {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          defaultValue: null
        });
      }
      if (!identityTable.sponsor_name) {
        await queryInterface.addColumn('rcm_identities', 'sponsor_name', {
          type: Sequelize.STRING(100),
          allowNull: true,
          defaultValue: null
        });
      }
      if (!identityTable.proposer_name) {
        await queryInterface.addColumn('rcm_identities', 'proposer_name', {
          type: Sequelize.STRING(100),
          allowNull: true,
          defaultValue: null
        });
      }
      if (!identityTable.display_wall) {
        await queryInterface.addColumn('rcm_identities', 'display_wall', {
          type: Sequelize.STRING(10),
          allowNull: true,
          defaultValue: 'N'
        });
      }
      if (!identityTable.custom_photo_url) {
        await queryInterface.addColumn('rcm_identities', 'custom_photo_url', {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null
        });
      }
      if (!identityTable.tehsil) {
        await queryInterface.addColumn('rcm_identities', 'tehsil', {
          type: Sequelize.STRING(100),
          allowNull: true,
          defaultValue: null
        });
      }
      if (!identityTable.post_village) {
        await queryInterface.addColumn('rcm_identities', 'post_village', {
          type: Sequelize.STRING(150),
          allowNull: true,
          defaultValue: null
        });
      }
      if (!identityTable.pincode) {
        await queryInterface.addColumn('rcm_identities', 'pincode', {
          type: Sequelize.STRING(10),
          allowNull: true,
          defaultValue: null
        });
      }
    }

    // 2. Reconcile rcm_downline_nodes
    const downlineTable = await queryInterface.describeTable('rcm_downline_nodes').catch(() => null);
    if (downlineTable) {
      if (!downlineTable.sponsor_id) {
        await queryInterface.addColumn('rcm_downline_nodes', 'sponsor_id', {
          type: Sequelize.INTEGER.UNSIGNED,
          allowNull: true,
          defaultValue: null
        });
      }
      if (!downlineTable.leg_type) {
        await queryInterface.addColumn('rcm_downline_nodes', 'leg_type', {
          type: Sequelize.STRING(10),
          allowNull: true,
          defaultValue: null
        });
      }
      if (!downlineTable.level) {
        await queryInterface.addColumn('rcm_downline_nodes', 'level', {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1
        });
      }
      if (!downlineTable.lineage_path) {
        await queryInterface.addColumn('rcm_downline_nodes', 'lineage_path', {
          type: Sequelize.TEXT,
          allowNull: true,
          defaultValue: null
        });
      }
    }
  },

  async down(queryInterface) {
    // Down rollback if needed
    const identityTable = await queryInterface.describeTable('rcm_identities').catch(() => null);
    if (identityTable) {
      if (identityTable.sponsor_id) await queryInterface.removeColumn('rcm_identities', 'sponsor_id');
      if (identityTable.proposer_id) await queryInterface.removeColumn('rcm_identities', 'proposer_id');
      if (identityTable.sponsor_name) await queryInterface.removeColumn('rcm_identities', 'sponsor_name');
      if (identityTable.proposer_name) await queryInterface.removeColumn('rcm_identities', 'proposer_name');
      if (identityTable.display_wall) await queryInterface.removeColumn('rcm_identities', 'display_wall');
      if (identityTable.custom_photo_url) await queryInterface.removeColumn('rcm_identities', 'custom_photo_url');
      if (identityTable.tehsil) await queryInterface.removeColumn('rcm_identities', 'tehsil');
      if (identityTable.post_village) await queryInterface.removeColumn('rcm_identities', 'post_village');
      if (identityTable.pincode) await queryInterface.removeColumn('rcm_identities', 'pincode');
    }

    const downlineTable = await queryInterface.describeTable('rcm_downline_nodes').catch(() => null);
    if (downlineTable) {
      if (downlineTable.sponsor_id) await queryInterface.removeColumn('rcm_downline_nodes', 'sponsor_id');
      if (downlineTable.leg_type) await queryInterface.removeColumn('rcm_downline_nodes', 'leg_type');
      if (downlineTable.level) await queryInterface.removeColumn('rcm_downline_nodes', 'level');
      if (downlineTable.lineage_path) await queryInterface.removeColumn('rcm_downline_nodes', 'lineage_path');
    }
  }
};
