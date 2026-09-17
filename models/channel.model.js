const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Channel = sequelize.define(
    'Channel',
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      youtubeChannelId: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
        field: 'youtube_channel_id',
      },
      handle: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      name: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      logoUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        field: 'logo_url',
      },
      uploadsPlaylistId: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'uploads_playlist_id',
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'is_active',
      },
      lastSyncedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_synced_at',
      },
      lastSyncStatus: {
        type: DataTypes.STRING(20),
        defaultValue: 'ok',
        field: 'last_sync_status',
      },
      lastSyncError: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'last_sync_error',
      },
      checkLiveStatus: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'check_live_status',
      },
      isLiveNow: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_live_now',
      },
      upcomingPremiereAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'upcoming_premiere_at',
      },
      upcomingVideoId: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'upcoming_video_id',
      },
      scheduledStartTime: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'scheduled_start_time',
      },
      discoveredAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'discovered_at',
      },
      isCurrentlyLive: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'is_currently_live',
      },
      liveVideoId: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'live_video_id',
      },
      liveStartedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'live_started_at',
      },
      lastLiveCheckAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_live_check_at',
      },
      lastNotifiedVideoId: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'last_notified_video_id',
      },
      lastKnownLiveStartTime: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_known_live_start_time',
      },
      isPinned: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
        field: 'is_pinned',
      },
      bannerUrl: {
        type: DataTypes.STRING(500),
        allowNull: true,
        field: 'banner_url',
      },
      subscriberCount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        field: 'subscriber_count',
      },
      videoCount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        field: 'video_count',
      },
      viewCount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        field: 'view_count',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      joinedDate: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'joined_date',
      },
      country: {
        type: DataTypes.STRING(10),
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'channels',
      timestamps: false,
      indexes: [
        { fields: ['youtube_channel_id'], unique: true },
        { fields: ['is_active'] },
      ],
    }
  );

  Channel.associate = (models) => {
    Channel.hasMany(models.ChannelVideo, {
      foreignKey: 'channelId',
      as: 'videos',
      onDelete: 'CASCADE',
    });
  };

  return Channel;
};
