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
      isAvailable: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'is_available',
      },
      liveBroadcastContent: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'live_broadcast_content',
      },
      scheduledStartTime: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'scheduled_start_time',
      },
      isShort: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        defaultValue: null,
        field: 'is_short',
      },
      totalSeconds: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
        field: 'total_seconds',
      },
      durationStr: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: '',
        field: 'duration_str',
      },
      viewCount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        field: 'view_count',
      },
      likesCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        field: 'likes_count',
      },
      commentsCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        field: 'comments_count',
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
        { fields: ['is_short'] },
        { fields: ['total_seconds'] },
        { fields: ['view_count'] },
      ],
    }
  );

  ChannelVideo.associate = (models) => {
    ChannelVideo.belongsTo(models.Channel, {
      foreignKey: 'channelId',
      as: 'channel',
    });
    ChannelVideo.hasMany(models.ShortInteraction, {
      foreignKey: 'channelVideoId',
      as: 'interactions',
      onDelete: 'CASCADE',
    });
    ChannelVideo.hasMany(models.ShortComment, {
      foreignKey: 'channelVideoId',
      as: 'comments',
      onDelete: 'CASCADE',
    });
  };

  return ChannelVideo;
};
