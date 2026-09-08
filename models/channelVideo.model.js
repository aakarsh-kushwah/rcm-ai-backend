const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ChannelVideo = sequelize.define(
    'ChannelVideo',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      channelId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'channel_id',
        references: {
          model: 'channels',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      youtubeVideoId: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
        field: 'youtube_video_id',
      },
      title: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      thumbnailUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        field: 'thumbnail_url',
      },
      publishedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'published_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'channel_videos',
      timestamps: false,
      indexes: [
        { fields: ['youtube_video_id'], unique: true },
        { fields: ['channel_id'] },
        { fields: ['published_at'] },
      ],
    }
  );

  ChannelVideo.associate = (models) => {
    ChannelVideo.belongsTo(models.Channel, {
      foreignKey: 'channelId',
      as: 'channel',
    });
  };

  return ChannelVideo;
};
