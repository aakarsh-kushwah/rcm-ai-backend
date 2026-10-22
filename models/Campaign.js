/**
 * @file src/models/Campaign.js
 * @description Notification Campaign Tracking Model
 */

module.exports = (sequelize, DataTypes) => {
    const Campaign = sequelize.define('Campaign', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        jobId: {
            type: DataTypes.STRING(255),
            allowNull: false,
            unique: true
        },
        title: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        body: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        imageUrl: {
            type: DataTypes.STRING(512),
            allowNull: true
        },
        actionUrl: {
            type: DataTypes.STRING(512),
            allowNull: true
        },
        totalTokens: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        successCount: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        failureCount: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        status: {
            type: DataTypes.ENUM('PROCESSING', 'COMPLETED', 'FAILED'),
            defaultValue: 'PROCESSING'
        },
        triggeredBy: {
            type: DataTypes.INTEGER,
            allowNull: true
        }
    }, {
        tableName: 'Campaigns',
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['jobId']
            }
        ]
    });

    return Campaign;
};
