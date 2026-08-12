/**
 * @file src/models/admin.model.js
 * @description Titan Admin Model (Separated Admin IAM)
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Admin = sequelize.define(
    'Admin',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        field: 'name',
      },
      email: {
        type: DataTypes.STRING(200),
        allowNull: false,
        unique: true,
        validate: {
          isEmail: true,
        },
        field: 'email',
      },
      masterPassword: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'master_password',
      },
      role: {
        type: DataTypes.ENUM('ADMIN', 'SUPER_ADMIN'),
        defaultValue: 'ADMIN',
      },
      status: {
        type: DataTypes.ENUM('pending', 'active', 'banned'),
        defaultValue: 'pending',
      },
      isApproved: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_approved',
      },
      verificationCode: {
        type: DataTypes.STRING(10),
        allowNull: true,
        field: 'verification_code',
      },
    },
    {
      tableName: 'admins',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          name: 'idx_admin_email',
          unique: true,
          fields: ['email'],
        },
        {
          name: 'idx_admin_status',
          fields: ['status'],
        }
      ],
    }
  );

  return Admin;
};
