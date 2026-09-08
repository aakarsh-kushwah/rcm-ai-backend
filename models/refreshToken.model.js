/**
 * @file src/models/refreshToken.model.js
 * @description Titan Opaque Refresh Token Model (Secure Rotation & Revocation)
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const RefreshToken = sequelize.define(
        'RefreshToken',
        {
            id: {
                type: DataTypes.BIGINT,
                autoIncrement: true,
                primaryKey: true,
            },
            userId: {
                type: DataTypes.BIGINT,
                allowNull: true,
                field: 'user_id',
            },
            adminId: {
                type: DataTypes.STRING(255),
                allowNull: true,
                field: 'admin_id',
            },
            userType: {
                type: DataTypes.ENUM('USER', 'ADMIN'),
                defaultValue: 'USER',
                field: 'user_type',
            },
            tokenHash: {
                type: DataTypes.STRING(64),
                allowNull: false,
                unique: true,
                field: 'token_hash',
            },
            expiresAt: {
                type: DataTypes.DATE,
                allowNull: false,
                field: 'expires_at',
            },
            revokedAt: {
                type: DataTypes.DATE,
                allowNull: true,
                field: 'revoked_at',
            },
            userAgent: {
                type: DataTypes.TEXT,
                allowNull: true,
                field: 'user_agent',
            },
        },
        {
            tableName: 'refresh_tokens',
            timestamps: true,
            underscored: true,
            indexes: [
                {
                    name: 'idx_refresh_token_hash',
                    unique: true,
                    fields: ['token_hash'],
                },
                {
                    name: 'idx_refresh_user',
                    fields: ['user_id', 'user_type'],
                },
                {
                    name: 'idx_refresh_admin',
                    fields: ['admin_id', 'user_type'],
                },
            ],
        }
    );

    return RefreshToken;
};
