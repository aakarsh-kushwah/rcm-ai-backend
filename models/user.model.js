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
      status: {
        type: DataTypes.ENUM('pending', 'active', 'inactive'),
        defaultValue: 'pending',
      },
      fcmToken: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'fcm_token',
      },
      // ✅ FIX: Explicitly define timestamps to ensure mapping works
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at', // Forces SQL to use 'created_at'
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'updated_at', // Forces SQL to use 'updated_at'
      },
    },
    {
      tableName: 'users',
      timestamps: true, // Keeps auto-updating behavior
      underscored: true,
    }
  );

  return User;
};