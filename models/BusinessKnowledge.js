/**
 * @file rcm-ai-backend/models/BusinessKnowledge.js
 * @description Dynamic Business Knowledge Base Model for RCM Titan ASI
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const BusinessKnowledge = sequelize.define('BusinessKnowledge', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true
        },
        category: {
            type: DataTypes.STRING(50),
            allowNull: false,
            comment: "Category e.g. PV_BV_Rules, Performance_Bonus, Royalty_Bonus, etc."
        },
        title: {
            type: DataTypes.STRING(255),
            allowNull: false,
            comment: "Short heading for the knowledge chunk"
        },
        keywords: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: "Comma-separated search tags e.g. royalty, gold, star gold"
        },
        content: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: "Actual rule or data snippet"
        },
        isActive: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            field: 'is_active'
        }
    }, {
        tableName: 'business_knowledges',
        timestamps: true,
        underscored: true
    });

    return BusinessKnowledge;
};
