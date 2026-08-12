/**
 * @file src/models/SiteMap.js
 * @description RCM Website Neural Map (Navigation & Action Logic)
 * @scale 500M+ Users
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const SiteMap = sequelize.define('SiteMap', {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        
        // 🏷️ Feature Name: "New Joining", "Monthly Statement", "Password Reset"
        title: { 
            type: DataTypes.STRING(200), 
            allowNull: false, 
            unique: true 
        },

        // 🔗 Direct Link
        link: { type: DataTypes.STRING(500), allowNull: false },

        // 📂 Category: "Personal", "Business", "Tools"
        section: { type: DataTypes.STRING(100), defaultValue: 'General' },

        // 🧠 AI INSTRUCTION MANUAL (Step-by-Step Guide)
        // Store as JSON Array: 
        // ["Open App", "Click Menu", "Select KYC", "Upload Photo"]
        guideSteps: {
            type: DataTypes.JSON, 
            allowNull: false,
            defaultValue: []
        },

        // 📋 FORM REQUIREMENTS (AI will ask user for these)
        // JSON: ["Aadhar Number", "Bank IFSC", "Nominee Name"]
        requiredFields: {
            type: DataTypes.JSON,
            defaultValue: []
        },

        // 🤖 SEARCH TRIGGERS
        // JSON: ["salary", "paisa", "commission", "kahan dikhega"]
        keywords: {
            type: DataTypes.JSON,
            defaultValue: []
        }
    }, {
        tableName: 'SiteMaps',
        timestamps: true,
        indexes: [
            // Fast Text Search for AI
            { name: 'idx_sitemap_title', fields: ['title'] } 
        ]
    });

    return SiteMap;
};