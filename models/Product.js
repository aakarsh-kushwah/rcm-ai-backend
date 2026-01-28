/**
 * @file src/models/Product.js
 * @description RCM Deep Product Knowledge Base
 * @capability Ingredient Analysis & AI Inference
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const Product = sequelize.define('Product', {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        
        name: { type: DataTypes.STRING(255), allowNull: false },
        category: { type: DataTypes.STRING(100) },
        
        // 💰 Pricing Logic
        mrp: { type: DataTypes.FLOAT, defaultValue: 0 },
        dp: { type: DataTypes.FLOAT, defaultValue: 0 },
        pv: { type: DataTypes.INTEGER, defaultValue: 0 },

        // 📝 Basic Description
        description: { type: DataTypes.TEXT },

        // 🥗 DEEP KNOWLEDGE (Gemini Level Data)
        
        // JSON Array: ["Aloe Vera", "Neem", "Tulsi"]
        ingredients: { 
            type: DataTypes.JSON, 
            defaultValue: [] 
        },

        // JSON Array: ["Skin Glow", "Immunity Booster", "Anti-Aging"]
        healthBenefits: {
            type: DataTypes.JSON,
            defaultValue: []
        },

        // JSON: { "dosage": "2 times a day", "caution": "Not for kids under 5" }
        usageInfo: {
            type: DataTypes.JSON,
            defaultValue: {}
        },

        // 🔗 External Data
        sitePath: DataTypes.STRING,
        productUrl: DataTypes.STRING,
        imageUrl: { 
            type: DataTypes.TEXT, // String ki jagah TEXT (Bada storage)
            allowNull: true 
        },

        // 🏷️ AI Tags for Smart Recommendations
        // JSON: ["summer_special", "women_health", "weight_loss"]
        aiTags: {
            type: DataTypes.JSON,
            defaultValue: []
        }

    }, {
        tableName: 'Products',
        timestamps: true,
        indexes: [
            { name: 'idx_prod_name', fields: ['name'] },
            { name: 'idx_prod_category', fields: ['category'] }
        ]
    });

    return Product;
};