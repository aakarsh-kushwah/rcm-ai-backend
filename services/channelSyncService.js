const axios = require('axios');
const cron = require('node-cron');
const { Channel, ChannelVideo } = require('../models');
const logger = require('../utils/logger');

/**
 * Sync videos for a single YouTube channel from its uploads playlist
 * @param {object} channel - Sequelize Channel instance
 */
async function syncChannel(channel) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.warn('YOUTUBE_API_KEY is not configured in environment variables.');
    throw new Error('YOUTUBE_API_KEY is missing');
  }

  const playlistId = channel.uploadsPlaylistId;
  if (!playlistId) {
    throw new Error(`Channel ${channel.name} (${channel.id}) has no uploadsPlaylistId`);
  }

  let pageToken = '';
  let newVideosCount = 0;
  let reachedAlreadySynced = false;
  const lastSyncedAtTime = channel.lastSyncedAt ? new Date(channel.lastSyncedAt).getTime() : 0;

  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems`;
    const params = {
      part: 'snippet',
      playlistId: playlistId,
      maxResults: 50,
      key: apiKey,
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    try {
      const response = await axios.get(url, { params, timeout: 10000 });
      const items = response.data.items || [];

      if (items.length === 0) {
        break;
      }

      for (const item of items) {
        const snippet = item.snippet;
        if (!snippet || !snippet.resourceId || !snippet.resourceId.videoId) {
          continue;
        }

        const youtubeVideoId = snippet.resourceId.videoId;
        const title = snippet.title || 'Untitled Video';
        const thumbnailUrl =
          snippet.thumbnails?.high?.url ||
          snippet.thumbnails?.medium?.url ||
          snippet.thumbnails?.default?.url ||
          `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`;
        const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt) : new Date();

        // If we reach a video whose publishedAt <= channel.lastSyncedAt, we can stop
        if (lastSyncedAtTime && publishedAt.getTime() <= lastSyncedAtTime) {
          reachedAlreadySynced = true;
          break;
        }

        // Upsert or findOrCreate into ChannelVideo
        const [video, created] = await ChannelVideo.findOrCreate({
          where: { youtubeVideoId },
          defaults: {
            channelId: channel.id,
            title,
            thumbnailUrl,
            publishedAt,
          },
        });

        if (created) {
          newVideosCount++;
        }
      }

      pageToken = response.data.nextPageToken;
    } catch (err) {
      logger.error(`Error fetching playlist items for channel ${channel.name}: ${err.message}`);
      throw err;
    }
  } while (pageToken && !reachedAlreadySynced);

  // Update lastSyncedAt
  channel.lastSyncedAt = new Date();
  await channel.save();
  logger.info(`Channel ${channel.name} lastSyncedAt successfully updated to: ${channel.lastSyncedAt}`);

  logger.info(`Synced channel ${channel.name}: ${newVideosCount} new videos added.`);
  return newVideosCount;
}

/**
 * Sync all active channels
 */
async function syncAllActiveChannels() {
  logger.info('Starting scheduled sync for all active YouTube channels...');
  try {
    const activeChannels = await Channel.findAll({ where: { isActive: true } });
    let totalChecked = 0;
    let totalNewVideos = 0;

    for (const channel of activeChannels) {
      totalChecked++;
      try {
        const added = await syncChannel(channel);
        totalNewVideos += added;
      } catch (err) {
        logger.error(`Failed to sync channel ${channel.name} (ID: ${channel.id}): ${err.message}`);
      }
    }

    logger.info(`Channel sync completed. Checked: ${totalChecked} channels, New Videos Added: ${totalNewVideos}`);
  } catch (err) {
    logger.error(`Error in syncAllActiveChannels: ${err.message}`);
  }
}

// Register cron job: every 6 hours ("0 */6 * * *")
try {
  cron.schedule('0 */6 * * *', () => {
    syncAllActiveChannels();
  });
  logger.info('YouTube channel sync cron job scheduled successfully (every 6 hours).');
} catch (err) {
  logger.error(`Failed to schedule channel sync cron job: ${err.message}`);
}

module.exports = {
  syncChannel,
  syncAllActiveChannels,
};
