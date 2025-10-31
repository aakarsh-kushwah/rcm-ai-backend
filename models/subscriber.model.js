const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Subscriber = sequelize.define(
    'Subscriber',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      phoneNumber: {
        type: DataTypes.STRING(20),
        allowNull: false,
        field: 'phone_number',
      },
      subscribedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'subscribers',
      timestamps: false,
    }
  );

  return Subscriber;
};
