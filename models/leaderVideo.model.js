const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const LeaderVideo = sequelize.define(
    'LeaderVideo',
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
      tableName: 'leader_videos',
      timestamps: false,
      indexes: [{ fields: ['title'] }],
    }
  );

  return LeaderVideo;
};
