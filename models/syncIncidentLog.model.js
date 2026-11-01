'use strict';

module.exports = (sequelize, DataTypes) => {
  const SyncIncidentLog = sequelize.define(
    'SyncIncidentLog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      buyer_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      error_type: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'sync_incident_logs',
      timestamps: false,
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
      indexes: [
        { name: 'idx_incident_buyer', fields: ['buyer_id'] },
        { name: 'idx_incident_type', fields: ['error_type'] },
      ],
    }
  );

  return SyncIncidentLog;
};
