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
