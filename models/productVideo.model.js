// models/productVideo.model.js
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ProductVideo = sequelize.define(
    'ProductVideo',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      // --- Naya Column ---
      category: {
        type: DataTypes.STRING(255),
        allowNull: true,
        defaultValue: 'General',
      },
      videoUrl: {
        type: DataTypes.STRING(500),
        allowNull: false,
        field: 'video_url',
      },
      publicId: {
        type: DataTypes.STRING(200),
        allowNull: true,
        field: 'public_id',
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'product_videos',
      timestamps: false,
      indexes: [
        { fields: ['title'] },
        // { fields: ['category'] }, // <-- STEP 1: Ise temporarily COMMENT OUT karein
      ],
    }
  );

  return ProductVideo;
};