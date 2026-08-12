/**
 * @file src/models/User.js
 * @description Titan User Model (High-Scale Edition)
 * @capacity 500 Million+ Users (Uses BIGINT & Indexing)
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        // 🚀 SCALING FIX: 'INTEGER' ki limit 2 Billion hoti hai.
        // 50 Crore users + future growth ke liye 'BIGINT' safe hai.
        type: DataTypes.BIGINT, 
        autoIncrement: true,
        primaryKey: true,
      },

      fullName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        field: 'full_name',
      },



      googleId: {
        type: DataTypes.STRING(200),
        allowNull: true,
        unique: true,
        field: 'google_id',
      },

      avatar: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'avatar',
      },

      email: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          isEmail: true, // Data integrity check
        },
      },

      phone: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },



      role: {
        type: DataTypes.ENUM('USER'),
        defaultValue: 'USER',
      },

      // 💰 Payment & Status Management
      autoPayStatus: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'auto_pay_status',
      },

      nextBillingDate: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'next_billing_date',
      },

      razorpayCustomerId: {
        type: DataTypes.STRING(200),
        allowNull: true,
        field: 'razorpay_customer_id',
      },

      // ✅ FIX FOR ERROR: Added 'premium' and 'banned'
      status: {
        type: DataTypes.ENUM('pending', 'active', 'inactive', 'premium', 'banned'),
        defaultValue: 'pending',
      },

      // 🕒 Timestamps
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'updated_at',
      },
    },
    {
      tableName: 'users',
      timestamps: true,
      underscored: true,
      
      // 🛡️ SECURITY: Soft Delete (Galti se user delete na ho)
      // paranoid: true, // (Optional: Ise baad me enable kar sakte hain)

      // 🚀 PERFORMANCE INDEXES (Crucial for 50Cr Users)
      indexes: [
        {
          name: 'idx_user_email',
          unique: true,
          fields: ['email'],
        },

        {
          name: 'idx_user_phone',
          fields: ['phone'],
        },
        {
          name: 'idx_user_status', // Dashboard filtering ke liye fast hoga
          fields: ['status'],
        }
      ],
    }
  );

  return User;
};