/**
 * @file src/models/VoiceResponse.js
 * @description RCM AI Voice Cache (TTS Engine Memory)
 * @scale High-Performance Caching (Prevents API Bill Shock)
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    // 🛠️ FIX: Model Name 'VoiceResponse' (PascalCase) hona jaruri hai
    const VoiceResponse = sequelize.define('VoiceResponse', {
        id: {
            type: DataTypes.BIGINT, // 🚀 SCALE: 50 Crore cache entries ke liye
            autoIncrement: true,
            primaryKey: true,
        },
        textHash: {
            type: DataTypes.STRING(64), // SHA-256 Hash
            allowNull: false,
            unique: true, 
            comment: "SHA-256 hash of the normalized text for fast lookup"
        },
        originalText: {
            type: DataTypes.TEXT, // Full text store karein (Debug ke liye)
            allowNull: false,
        },
        audioUrl: {
            type: DataTypes.STRING(500), // 🛡️ SAFETY: Cloudinary URLs lambe ho sakte hain
            allowNull: false,
            comment: "The Cloudinary secure URL"
        },
        voiceId: {
            type: DataTypes.STRING(100),
            defaultValue: "IvLWq57RKibBrqZGpQrC" // Default Voice ID (e.g. Swara/Rachel)
        },
        fileSize: {
            type: DataTypes.INTEGER, // Size in Bytes (Optional Analytics)
            defaultValue: 0
        },
        duration: {
            type: DataTypes.FLOAT, // Audio length in seconds
            defaultValue: 0.0
        }
    }, {
        tableName: 'voice_responses',
        timestamps: true,
        
        // ⚡ SUPER FAST CACHE LOOKUP
        indexes: [
            {
                name: 'idx_voice_hash', 
                unique: true,
                fields: ['textHash']
            }
        ]
    });

    return VoiceResponse;
};