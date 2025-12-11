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
        // Stores the main trigger, e.g., "what is rcm"
      },
      tags: {
        type: DataTypes.JSON, 
        defaultValue: [],
        // Stores variations like ["define rcm", "rcm details"]
      },
      answer: {
        type: DataTypes.TEXT,
        allowNull: false,
        // The fixed answer text
      },
      audioUrl: {
        type: DataTypes.STRING,
        allowNull: true,
        // The pre-recorded audio URL
      }
    },
    {
      tableName: 'faqs',
      timestamps: true,
    }
  );

  return FAQ;
};