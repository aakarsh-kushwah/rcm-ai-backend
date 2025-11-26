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
        // ✅ PRO: ENUM use karein taaki data consistent rahe
        type: DataTypes.ENUM('USER', 'BOT', 'SYSTEM'), 
        allowNull: false,
        defaultValue: 'USER',
        validate: {
          isIn: [['USER', 'BOT', 'SYSTEM']]
        }
      },
      message: {
        // ✅ PRO: TEXT (64KB) kaafi hai, par validation zaroori hai
        type: DataTypes.TEXT, 
        allowNull: false,
        validate: {
          notEmpty: { msg: "Message cannot be empty" } 
        }
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        // ✅ Relational Integrity
        references: {
          model: 'users', // Table name small letters mein hi hota hai aksar
          key: 'id'
        },
        onDelete: 'CASCADE', // Agar User delete ho, to Chat bhi udd jaye
        onUpdate: 'CASCADE'
      },
    },
    {
      tableName: 'chat_messages',
      timestamps: true,
      createdAt: 'createdAt',
      updatedAt: false,       // Chat history edit nahi hoti, isliye updatedAt ki zaroorat nahi
      
      // ✅ SUPER CRITICAL FOR CHAT APPS:
      charset: 'utf8mb4',     // Emojis (😎) aur Hindi (नमस्ते) support ke liye
      collate: 'utf8mb4_unicode_ci',
      
      indexes: [
        {
          // ✅ PERFORMANCE BOOSTER: 
          // Jab aap `WHERE userId = X ORDER BY createdAt DESC` karte hain, 
          // ye index query ko millisecond mein execute karwata hai.
          name: 'user_chat_history_idx',
          fields: ['userId', 'createdAt']
        }
      ]
    }
  );

  return ChatMessage;
};