// models/User.js (Updated)

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      fullName: {
        type: DataTypes.STRING(200),
        allowNull: false,
        field: 'full_name',
      },
      rcmId: {
        type: DataTypes.STRING(200),
        allowNull: true,
        unique: false, 
        field: 'rcm_id',
      },
      email: {
        type: DataTypes.STRING(200),
        allowNull: false,
        unique: false, 
      },
      phone: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      password: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      role: {
        type: DataTypes.ENUM('USER', 'ADMIN'),
        defaultValue: 'USER',
      },
      autoPayStatus: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      nextBillingDate: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      razorpayCustomerId: {
        type: DataTypes.STRING(200),
        allowNull: true,
        field: 'razorpay_customer_id',
      },
      status: {
        type: DataTypes.ENUM('pending', 'active', 'inactive'),
        defaultValue: 'pending',
      },
      // ✅ NAYA FIELD (Base64 string save karne ke liye)
      profilePic: {
        type: DataTypes.TEXT, // ⭐️ TEXT istemaal karein, STRING chhota pad sakta hai
        allowNull: true,
        field: 'profile_pic',
        defaultValue: null
      }
    },
    {
      tableName: 'users',
      timestamps: true,
      createdAt: 'createdAt',
      updatedAt: false, // ⭐️ Note: Aapka 'updatedAt' false hai
      underscored: true,
    }
  );

  return User;
};