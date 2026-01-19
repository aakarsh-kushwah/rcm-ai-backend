/**
 * @file src/models/FAQ.js
 * @description RCM Static Knowledge Base
 * @usage AI uses this for "Ratt-Rattaya" (Fixed) answers to save Token Cost.
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const FAQ = sequelize.define('FAQ', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        question: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: "The query to match"
        },
        answer: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: "The official RCM answer"
        },
        // 📂 Categorization for faster filtering
        category: {
            type: DataTypes.STRING(50),
            defaultValue: 'General' // e.g. 'Plan', 'Product', 'Tech'
        },
        // 🗣️ Voice Handling
        audioUrl: {
            type: DataTypes.STRING(500),
            allowNull: true
        },
        voiceType: {
            type: DataTypes.ENUM('ELEVENLABS', 'EDGE', 'NONE'),
            defaultValue: 'NONE'
        },
        // ✅ Status Control
        status: {
            type: DataTypes.ENUM('APPROVED', 'PENDING_REVIEW', 'ARCHIVED'),
            defaultValue: 'APPROVED'
        },
        // 📈 Smart Ranking: Jawab jitna helpful, utna upar aayega
        helpfulCount: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        language: {
            type: DataTypes.STRING(10),
            defaultValue: 'hi-IN' // RCM ke liye Hindi default
        },
        tags: {
            type: DataTypes.JSON, // e.g. ["login", "password", "reset"]
            defaultValue: []
        }
    }, {
        tableName: 'FAQs',
        timestamps: true,
        indexes: [
            {
                name: 'idx_faq_category',
                fields: ['category', 'status']
            }
            // Note: Full Text Search index can be added manually if using MySQL
        ]
    });

    return FAQ;
};