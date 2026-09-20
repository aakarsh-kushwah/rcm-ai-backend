const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ShortInteraction = sequelize.define(
    'ShortInteraction',
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
      type: {
        type: DataTypes.STRING(50),
        defaultValue: 'like',
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'short_interactions',
      timestamps: false,
      indexes: [
        {
          unique: true,
          fields: ['user_id', 'channel_video_id', 'type'],
          name: 'unique_user_video_interaction',
        },
        { fields: ['channel_video_id'] },
      ],
    }
  );

  ShortInteraction.associate = (models) => {
    ShortInteraction.belongsTo(models.User, {
      foreignKey: 'userId',
      as: 'user',
    });
    ShortInteraction.belongsTo(models.ChannelVideo, {
      foreignKey: 'channelVideoId',
      as: 'video',
    });
  };

  return ShortInteraction;
};
