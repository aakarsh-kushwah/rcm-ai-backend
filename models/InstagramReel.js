const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const InstagramReel = sequelize.define(
    'InstagramReel',
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      accountId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'account_id',
        references: {
          model: 'instagram_accounts',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      shortcode: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      url: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      title: {
        type: DataTypes.TEXT,
      },
      thumbnailUrl: {
        type: DataTypes.TEXT,
        field: 'thumbnail_url',
      },
      videoUrl: {
        type: DataTypes.TEXT,
        field: 'video_url',
      },
      creatorHandle: {
        type: DataTypes.STRING(100),
        field: 'creator_handle',
      },
      category: {
        type: DataTypes.STRING(50),
        defaultValue: 'Motivation',
      },
      likesCount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        field: 'likes_count',
      },
      commentsCount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        field: 'comments_count',
      },
      viewCount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        field: 'view_count',
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'is_active',
      },
    },
    {
      tableName: 'instagram_reels',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          unique: true,
          fields: ['shortcode'],
        },
        {
          fields: ['is_active', 'category', 'created_at', 'id'],
          name: 'instagram_reels_feed_candidate_idx',
        },
        {
          fields: ['account_id'],
        },
      ],
    }
  );

  InstagramReel.associate = (models) => {
    InstagramReel.belongsTo(models.InstagramAccount, {
      foreignKey: 'accountId',
      as: 'account',
    });
  };

  return InstagramReel;
};
