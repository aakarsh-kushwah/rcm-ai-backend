/**
 * @file src/models/NotificationToken.js
 * @description Titan Notification Registry
 * @fix Solves 'Unique Key' conflict by defining index only once.
 */

module.exports = (sequelize, DataTypes) => {
    const NotificationToken = sequelize.define('NotificationToken', {
        
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },

        userId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'Linked User ID (Null for Guest Mode)'
        },

        // ✅ FIX: Yahan se 'unique: true' HATA DIYA hai.
        // Ab Sequelize DB se ladega nahi.
        token: {
            type: DataTypes.STRING(512), 
            allowNull: false,
            // unique: true,  <-- ❌ REMOVED (Duplicate definition)
            validate: {
                notEmpty: true
            }
        },

        deviceFingerprint: {
            type: DataTypes.STRING(255),
            allowNull: true
        },

        platform: {
            type: DataTypes.ENUM('ANDROID', 'IOS', 'WEB', 'DESKTOP'),
            defaultValue: 'WEB',
            allowNull: false
        },

        deviceMeta: {
            type: DataTypes.JSON,
            defaultValue: {}
        },

        preferences: {
            type: DataTypes.JSON,
            defaultValue: { marketing: true, transactional: true, updates: true }
        },

        failureCount: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },

        status: {
            type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'BOUNCED', 'UNINSTALLED'),
            defaultValue: 'ACTIVE'
        },

        lastNotifiedAt: { type: DataTypes.DATE, allowNull: true },
        lastUsedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }

    }, {
        tableName: 'NotificationTokens',
        timestamps: true,
        
        // 🚀 CONTROL CENTER: Index yahan define karenge (Sirf Ek Baar)
        indexes: [
            {
                name: 'idx_token_lookup', // ✅ Is naam se index banega
                unique: true,             // ✅ Yahan unique lagaya hai
                fields: ['token'] 
            },
            {
                name: 'idx_active_users',
                fields: ['userId', 'status', 'platform'] 
            },
            {
                name: 'idx_cleanup_candidates',
                fields: ['updatedAt'] 
            }
        ]
    });

    return NotificationToken;
};