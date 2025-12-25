const { DataTypes } = require('sequelize');
const crypto = require('crypto');

module.exports = (sequelize) => {
  const VoiceResponse = sequelize.define(
    'VoiceResponse',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      textHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true, 
        comment: "SHA-256 hash of the normalized text for fast lookup"
      },
      originalText: {
        type: DataTypes.TEXT, // Storing full text just in case needed for debug
        allowNull: false,
      },
      audioUrl: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: "The Cloudinary secure URL"
      },
      voiceId: {
        type: DataTypes.STRING,
        defaultValue: "IvLWq57RKibBrqZGpQrC" // Store which voice was used
      }
    },
    {
      tableName: 'voice_responses',
      timestamps: true,
    }
  );

  return VoiceResponse;
};