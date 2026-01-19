/**
 * @file src/models/chatMessage.model.js
 * @description RCM AI Conversation History (High-Speed Logger)
 * @scale Hyper-Scale (Optimized for billions of rows)
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    // ⚠️ Note: Model name 'ChatMessage' hi rakhein (PascalCase),
    // bhale hi file ka naam kuch bhi ho.
    // Isse Controller me 'db.ChatMessage' call karna aasan hoga.
    const ChatMessage = sequelize.define('ChatMessage', {
        id: {
            type: DataTypes.BIGINT, // 🚀 SCALE: Integer 2 billion par fail ho jayega, BIGINT jaruri hai
            autoIncrement: true,
            primaryKey: true,
        },
        userId: {
            type: DataTypes.BIGINT, // User ID bhi BIGINT honi chahiye agar User model me BIGINT hai
            allowNull: false,
            comment: "Linked User ID"
        },
        sender: {
            // ⚡ OPTIMIZATION: String bar-bar likhne se DB bharta hai.
            // ENUM use karne se size kam aur speed tej hoti hai.
            type: DataTypes.ENUM('user', 'ai', 'system'), 
            defaultValue: 'user',
            allowNull: false
        },
        message: {
            type: DataTypes.TEXT, // Lambi baat-cheet ke liye
            allowNull: false
        },
        isAudio: {
            type: DataTypes.BOOLEAN, // Kya user ne bolkar sawal pucha?
            defaultValue: false
        },
        // 📊 ANALYTICS: Cost aur Performance track karne ke liye
        metadata: {
            type: DataTypes.JSON, 
            defaultValue: {} // e.g. { "tokensUsed": 45, "responseTime": 200 }
        }
    }, {
        tableName: 'chat_messages', // Database table ka naam
        timestamps: true, // createdAt aur updatedAt dono rahenge
        updatedAt: false, // ⚡ SPEED: Chat history kabhi change nahi hoti, update time band karke speed badhayein
        
        // ⚡ SUPER FAST HISTORY FETCH INDEX
        indexes: [
            {
                name: 'idx_chat_history',
                fields: ['userId', 'createdAt'] // User ki purani chat mili-seconds me layega
            }
        ]
    });

    return ChatMessage;
};