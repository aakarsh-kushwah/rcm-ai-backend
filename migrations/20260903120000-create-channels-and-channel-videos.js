'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('channels', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      youtube_channel_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true,
      },
      handle: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      logo_url: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      uploads_playlist_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
      },
      last_synced_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('channel_videos', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      channel_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'channels',
          key: 'id',
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      youtube_video_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true,
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      thumbnail_url: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      published_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('channels', ['youtube_channel_id'], { unique: true });
    await queryInterface.addIndex('channels', ['is_active']);
    await queryInterface.addIndex('channel_videos', ['youtube_video_id'], { unique: true });
    await queryInterface.addIndex('channel_videos', ['channel_id']);
    await queryInterface.addIndex('channel_videos', ['published_at']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('channel_videos');
    await queryInterface.dropTable('channels');
  }
};
