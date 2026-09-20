const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ShortComment = sequelize.define(
    'ShortComment',
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        field: 'user_id',
        references: {
          model: 'users',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      channelVideoId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'channel_video_id',
        references: {
          model: 'channel_videos',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      comment: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'short_comments',
      timestamps: false,
      indexes: [
        { fields: ['channel_video_id'] },
        { fields: ['user_id'] },
      ],
    }
  );

  ShortComment.associate = (models) => {
    ShortComment.belongsTo(models.User, {
      foreignKey: 'userId',
      as: 'user',
    });
    ShortComment.belongsTo(models.ChannelVideo, {
      foreignKey: 'channelVideoId',
      as: 'video',
    });
  };

  return ShortComment;
};
