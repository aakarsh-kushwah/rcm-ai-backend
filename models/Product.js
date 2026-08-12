/**
 * @file src/models/Product.js
 * @description TITAN V51: RCM NEURAL KNOWLEDGE BASE (Optimized for AI Inference)
 * @capability Precise Pricing, Deep Knowledge Extraction, AI Search
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const Product = sequelize.define('Product', {
        id: { 
            type: DataTypes.INTEGER, 
            autoIncrement: true, 
            primaryKey: true 
        },
        
        name: { 
            type: DataTypes.STRING(255), 
            allowNull: false,
            validate: { notEmpty: true }, // Khali naam allow nahi hoga
            comment: "Official RCM Product Name"
        },

        category: { 
            type: DataTypes.STRING(100),
            set(val) { this.setDataValue('category', val?.toUpperCase()); }, // Auto Uppercase for consistency
            comment: "Top-level category (e.g., HEALTH-CARE)"
        },
        
        // 💰 PRICING LOGIC (Using DECIMAL for exact currency calculation)
        mrp: { 
            type: DataTypes.DECIMAL(10, 2), 
            defaultValue: 0,
            validate: { min: 0 }
        },
        dp: { 
            type: DataTypes.DECIMAL(10, 2), 
            defaultValue: 0,
            validate: { min: 0 }
        },
        pv: { 
            type: DataTypes.INTEGER, 
            defaultValue: 0,
            validate: { min: 0 }
        },

        // 📝 AI KNOWLEDGE CONTENT
        description: { 
            type: DataTypes.TEXT,
            comment: "Deep technical/marketing description for AI Context"
        },

        // JSON Array: ["Protein", "Fiber", "Vitamins"]
        ingredients: { 
            type: DataTypes.JSON, 
            defaultValue: [],
            get() { 
                const val = this.getDataValue('ingredients');
                return typeof val === 'string' ? JSON.parse(val) : val || [];
            }
        },

        // JSON Array: ["Muscle Growth", "Weight Management"]
        healthBenefits: {
            type: DataTypes.JSON,
            defaultValue: [],
            get() {
                const val = this.getDataValue('healthBenefits');
                return typeof val === 'string' ? JSON.parse(val) : val || [];
            }
        },

        // JSON Object: { "dosage": "1 scoop daily", "usage": "Mix with water" }
        usageInfo: {
            type: DataTypes.JSON,
            defaultValue: {},
            get() {
                const val = this.getDataValue('usageInfo');
                return typeof val === 'string' ? JSON.parse(val) : val || {};
            }
        },

        // 🔗 EXTERNAL LINKS & MEDIA
        sitePath: {
            type: DataTypes.STRING(255),
            comment: "Breadcrumb path on RCM site"
        },
        
        productUrl: { 
            type: DataTypes.STRING(500),
            unique: true, // Duplicate products block karne ke liye
            validate: { isUrl: true }
        },

        imageUrl: { 
            type: DataTypes.TEXT, 
            field: 'imageUrl', // 👈 FIX: Direct mapping to TiDB column to prevent snake_case errors
            allowNull: true,
            validate: {
                isUrl: { msg: "imageUrl must be a valid link (Cloudinary/RCM)" }
            }
        },

        // 🏷️ AI META TAGS (For Smart Search & Filtering)
        aiTags: {
            type: DataTypes.JSON,
            defaultValue: [],
            comment: "Tags like 'immunity', 'summer', 'best_seller' for neural search"
        },

        // 🚦 SYSTEM FIELDS
        isAvailable: {
            type: DataTypes.BOOLEAN,
            defaultValue: true
        }

    }, {
        tableName: 'Products',
        timestamps: true, // Adds createdAt & updatedAt
        underscored: false, // 👈 CRITICAL: Prevents 'image_url' bug
        indexes: [
            { name: 'idx_prod_name', fields: ['name'] },
            { name: 'idx_prod_category', fields: ['category'] },
            { name: 'idx_prod_url', fields: ['productUrl'] },
            { name: 'idx_prod_image', fields: ['imageUrl'] }
        ]
    });

    return Product;
};