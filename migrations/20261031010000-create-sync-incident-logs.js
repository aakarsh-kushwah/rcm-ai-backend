'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sync_incident_logs', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      buyer_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
      error_type: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    });

    await queryInterface.addIndex('sync_incident_logs', ['buyer_id'], { name: 'idx_incident_buyer' });
    await queryInterface.addIndex('sync_incident_logs', ['error_type'], { name: 'idx_incident_type' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sync_incident_logs');
  },
};
