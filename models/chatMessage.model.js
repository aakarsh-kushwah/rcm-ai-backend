const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ChatMessage = sequelize.define(
    'ChatMessage',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      sender: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      // ✅ Added Response Field (Controller me use ho raha tha par yaha missing tha)
      response: {
        type: DataTypes.TEXT,
        allowNull: true, 
      },
      // ✅ Added AudioUrl Field (Controller me use ho raha tha)
      audioUrl: {
        type: DataTypes.STRING(500),
        allowNull: true
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    },
    {
      tableName: 'chat_messages',
      timestamps: true, // ✅ True rakhein taaki createdAt aur updatedAt dono manage ho
      createdAt: 'createdAt',
      updatedAt: 'updatedAt', // ✅ Isse explicit kar dein
    }
  );

  return ChatMessage;
};