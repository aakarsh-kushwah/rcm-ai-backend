module.exports = (sequelize, DataTypes) => {
    const PaymentLog = sequelize.define('PaymentLog', {
        userId: DataTypes.INTEGER,
        paymentId: DataTypes.STRING,
        subscriptionId: DataTypes.STRING,
        amount: DataTypes.DECIMAL(10, 2),
        status: DataTypes.STRING, // 'initiated', 'success', 'failed'
        method: DataTypes.STRING, // 'card', 'upi', etc.
        ipAddress: DataTypes.STRING,
        errorDetails: DataTypes.TEXT
    });
    return PaymentLog;
};