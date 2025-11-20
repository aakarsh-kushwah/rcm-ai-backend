const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const YoutubeVideo = sequelize.define(
    'YoutubeVideo',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      // Foreign Key जो YoutubeChannel से लिंक होगा
      channelId: { 
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'channel_id',
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      videoUrl: {
        type: DataTypes.STRING(500),
        allowNull: false,
        field: 'video_url',
      },
      publicId: {
        type: DataTypes.STRING(200),
        allowNull: false, 
        unique: true, // डुप्लीकेट वीडियो IDs को रोकता है
        field: 'public_id',
      },
    },
    {
      tableName: 'youtube_channel_videos',
      timestamps: true,
      underscored: true,
      indexes: [{ fields: ['public_id'] }],
    }
  );
  return YoutubeVideo;
};