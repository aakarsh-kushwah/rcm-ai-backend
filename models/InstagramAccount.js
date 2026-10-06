const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const InstagramAccount = sequelize.define(
    'InstagramAccount',
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      username: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      displayName: {
        type: DataTypes.STRING(150),
        field: 'display_name',
      },
      avatarUrl: {
        type: DataTypes.TEXT,
        field: 'avatar_url',
      },
      category: {
        type: DataTypes.STRING(50),
        defaultValue: 'Motivation',
      },
      reelsCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        field: 'reels_count',
      },
      lastSyncedAt: {
        type: DataTypes.DATE,
        field: 'last_synced_at',
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'is_active',
      },
    },
    {
      tableName: 'instagram_accounts',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          unique: true,
          fields: ['username'],
        },
        {
          fields: ['is_active'],
        },
      ],
    }
  );

  InstagramAccount.associate = (models) => {
    InstagramAccount.hasMany(models.InstagramReel, {
      foreignKey: 'accountId',
      as: 'reels',
      onDelete: 'CASCADE',
    });
  };

  return InstagramAccount;
};
