const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FAQ = sequelize.define(
    'FAQ',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      question: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      tags: {
        type: DataTypes.JSON, 
        defaultValue: [],
      },
      answer: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      audioUrl: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      // --- NEW FIELDS FOR USER CONTRIBUTIONS ---
      isUserSubmitted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: "True if submitted by a normal user, False if by Admin"
      },
      status: {
        type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'),
        defaultValue: 'APPROVED', // Admin data is auto-approved. User data depends on AI.
      },
      rejectionReason: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: "Why AI rejected this submission"
      }
    },
    {
      tableName: 'faqs',
      timestamps: true,
    }
  );

  return FAQ;
};