'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Add columns to channels
    try {
      await queryInterface.addColumn('channels', 'is_shorts_only', {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      });
    } catch (e) {
      console.log('Column is_shorts_only might already exist:', e.message);
    }

    try {
      await queryInterface.addColumn('channels', 'shorts_count', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      });
    } catch (e) {
      console.log('Column shorts_count might already exist:', e.message);
    }

    // Add columns to channel_videos
    try {
      await queryInterface.addColumn('channel_videos', 'is_short', {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      });
    } catch (e) {
      console.log('Column is_short might already exist:', e.message);
    }

    try {
      await queryInterface.addColumn('channel_videos', 'likes_count', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      });
    } catch (e) {
      console.log('Column likes_count might already exist:', e.message);
    }

    try {
      await queryInterface.addColumn('channel_videos', 'comments_count', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      });
    } catch (e) {
      console.log('Column comments_count might already exist:', e.message);
    }

    // Add index on is_short for channel_videos
    try {
      await queryInterface.addIndex('channel_videos', ['is_short'], {
        name: 'idx_channel_videos_is_short',
      });
    } catch (e) {
      console.log('Index might already exist:', e.message);
    }

    // Create short_interactions table if not exists
    try {
      await queryInterface.createTable('short_interactions', {
        id: {
          type: Sequelize.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        user_id: {
          type: Sequelize.BIGINT,
          allowNull: false,
          references: {
            model: 'users',
            key: 'id',
          },
          onDelete: 'CASCADE',
        },
        channel_video_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'channel_videos',
            key: 'id',
          },
          onDelete: 'CASCADE',
        },
        type: {
          type: Sequelize.STRING(50),
          defaultValue: 'like',
          allowNull: false,
        },
        created_at: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.NOW,
        },
      });
    } catch (e) {
      console.log('Table short_interactions might already exist:', e.message);
    }

    try {
      await queryInterface.addIndex('short_interactions', ['user_id', 'channel_video_id', 'type'], {
        unique: true,
        name: 'unique_user_video_interaction',
      });
    } catch (e) {
      console.log('Index might already exist:', e.message);
    }

    // Create short_comments table if not exists
    try {
      await queryInterface.createTable('short_comments', {
        id: {
          type: Sequelize.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        user_id: {
          type: Sequelize.BIGINT,
          allowNull: false,
          references: {
            model: 'users',
            key: 'id',
          },
          onDelete: 'CASCADE',
        },
        channel_video_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'channel_videos',
            key: 'id',
          },
          onDelete: 'CASCADE',
        },
        comment: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        created_at: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.NOW,
        },
      });
    } catch (e) {
      console.log('Table short_comments might already exist:', e.message);
    }

    try {
      await queryInterface.addIndex('short_comments', ['channel_video_id'], {
        name: 'idx_short_comments_video_id',
      });
    } catch (e) {
      console.log('Index might already exist:', e.message);
    }
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('short_comments');
    await queryInterface.dropTable('short_interactions');
    await queryInterface.removeColumn('channel_videos', 'comments_count');
    await queryInterface.removeColumn('channel_videos', 'likes_count');
    await queryInterface.removeColumn('channel_videos', 'is_short');
    await queryInterface.removeColumn('channels', 'shorts_count');
    await queryInterface.removeColumn('channels', 'is_shorts_only');
  },
};
