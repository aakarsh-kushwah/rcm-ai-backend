const axios = require('axios');
const cron = require('node-cron');
const EventEmitter = require('events');
const { Channel, ChannelVideo } = require('../models');
const { parse } = require('iso8601-duration');

let logger;
try {
  logger = require('../utils/logger');
} catch (e) {
  logger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.log
  };
}

// ------------------------------------------------------------------
// Email alerts & notification triggers completely removed & neutralized
// to stop rate-limiting / login attempt / Gmail 454 errors.
// ------------------------------------------------------------------

// Event emitter for live transitions
class LiveEventEmitter extends EventEmitter {}
const liveEmitter = new LiveEventEmitter();

// Daily quota tracking for Priority 4 / Live Detection
let dailyQuotaSpent = 0;
let lastQuotaLogDate = new Date().toDateString();

function trackQuota(units) {
  const today = new Date().toDateString();
  if (today !== lastQuotaLogDate) {
    logger.info(`[Quota Audit] Previous day total quota spent on live/upcoming checks: ${dailyQuotaSpent} units.`);
    dailyQuotaSpent = 0;
    lastQuotaLogDate = today;
  }
  dailyQuotaSpent += units;
  logger.info(`[Quota Audit] Spent ${units} units. Today's cumulative quota spent: ${dailyQuotaSpent} units.`);
}

/**
 * Helper to get playlist IDs from channelId ('UC' prefix sliced)
 */
function getPlaylistIds(channelId) {
  const cleanId = channelId && channelId.startsWith('UC') ? channelId.slice(2) : channelId;
  return {
    uploads: 'UU' + cleanId,
    longOnly: 'UULF' + cleanId,
    shortsOnly: 'UUSH' + cleanId,
  };
}

/**
 * Refresh channel metadata & statistics from YouTube Data API v3
 * @param {object} channel - Sequelize Channel instance
 */
async function refreshChannelMetadata(channel) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !channel.youtubeChannelId) return;

  try {
    const response = await axios.get(`https://www.googleapis.com/youtube/v3/channels`, {
      params: {
        part: 'snippet,statistics,brandingSettings,contentDetails',
        id: channel.youtubeChannelId,
        key: apiKey,
      },
      timeout: 10000,
    });
    trackQuota(1);

    const items = response.data.items || [];
    if (items.length === 0) return;

    const chData = items[0];
    const snippet = chData.snippet || {};
    const statistics = chData.statistics || {};
    const branding = chData.brandingSettings || {};
    const contentDetails = chData.contentDetails || {};

    channel.name = snippet.title || channel.name;
    channel.handle = snippet.customUrl || channel.handle;
    channel.logoUrl = snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || channel.logoUrl;
    channel.description = snippet.description || channel.description;
    channel.joinedDate = snippet.publishedAt ? new Date(snippet.publishedAt) : channel.joinedDate;
    channel.country = snippet.country || channel.country;
    channel.subscriberCount = statistics.subscriberCount ? parseInt(statistics.subscriberCount, 10) : channel.subscriberCount;
    channel.videoCount = statistics.videoCount ? parseInt(statistics.videoCount, 10) : channel.videoCount;
    channel.viewCount = statistics.viewCount ? parseInt(statistics.viewCount, 10) : channel.viewCount;
    channel.bannerUrl = branding.image?.bannerExternalUrl || channel.bannerUrl;

    if (!channel.uploadsPlaylistId && contentDetails.relatedPlaylists?.uploads) {
      channel.uploadsPlaylistId = contentDetails.relatedPlaylists.uploads;
    }

    await channel.save();
    logger.info(`[Channel Metadata Refresh] Successfully updated stats & metadata for channel "${channel.name}"`);
  } catch (err) {
    logger.error(`Error refreshing metadata for channel ${channel.name}: ${err.message}`);
  }
}

/**
 * Refresh metadata & statistics for all active channels
 */
async function refreshMetadataForAllChannels() {
  logger.info('Starting scheduled metadata & statistics refresh for all active YouTube channels...');
  try {
    const activeChannels = await Channel.findAll({ where: { isActive: true } });
    for (const channel of activeChannels) {
      await refreshChannelMetadata(channel);
    }
    logger.info('Channel metadata & statistics refresh completed.');
  } catch (err) {
    logger.error(`Error in refreshMetadataForAllChannels: ${err.message}`);
  }
}

/**
 * Helper to fetch and process a specific playlist (UULF or UUSH or UU)
 */
async function processPlaylistItems(channel, playlistId, isShortVal, apiKey, lastSyncedAtTime, maxPages = 0) {
  let pageToken = '';
  let newVideosCount = 0;
  let reachedAlreadySynced = false;
  let pagesFetched = 0;

  do {
    if (maxPages > 0 && pagesFetched >= maxPages) break;
    pagesFetched++;

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

    const response = await axios.get(url, { params, timeout: 10000 });
    const items = response.data.items || [];

    if (items.length === 0) {
      break;
    }

    const videoIds = items.map(item => item.snippet?.resourceId?.videoId).filter(Boolean);
    if (videoIds.length === 0) {
      pageToken = response.data.nextPageToken;
      continue;
    }

    const videosDetailsRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${videoIds.join(',')}&key=${apiKey}`, { timeout: 10000 });
    trackQuota(videoIds.length > 0 ? 1 : 0);

    const videoDetailsMap = new Map();
    for (const videoItem of (videosDetailsRes.data.items || [])) {
      videoDetailsMap.set(videoItem.id, videoItem);
    }

    for (const item of items) {
      const snippet = item.snippet;
      if (!snippet || !snippet.resourceId || !snippet.resourceId.videoId) {
        continue;
      }

      const youtubeVideoId = snippet.resourceId.videoId;
      const videoData = videoDetailsMap.get(youtubeVideoId);

      const title = videoData?.snippet?.title || snippet.title || 'Untitled Video';
      const thumbnailUrl =
        videoData?.snippet?.thumbnails?.high?.url ||
        snippet.thumbnails?.high?.url ||
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.default?.url ||
        `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`;
      const publishedAt = videoData?.snippet?.publishedAt ? new Date(videoData.snippet.publishedAt) : (snippet.publishedAt ? new Date(snippet.publishedAt) : new Date());
      const liveBroadcastContent = videoData?.snippet?.liveBroadcastContent || 'none';
      const scheduledStartTime = videoData?.liveStreamingDetails?.scheduledStartTime ? new Date(videoData.liveStreamingDetails.scheduledStartTime) : null;

      if (lastSyncedAtTime && publishedAt.getTime() <= lastSyncedAtTime) {
        reachedAlreadySynced = true;
        break;
      }

      let isShort = isShortVal;
      let durationStr = videoData?.contentDetails?.duration || '';
      let totalSeconds = 0;
      let viewCount = videoData?.statistics?.viewCount ? parseInt(videoData.statistics.viewCount, 10) : 0;

      if (durationStr) {
        try {
          const durationObj = parse(durationStr);
          totalSeconds = (durationObj.hours || 0) * 3600 + (durationObj.minutes || 0) * 60 + (durationObj.seconds || 0);
        } catch (e) {
          logger.warn(`Could not parse duration for video ${youtubeVideoId}: ${e.message}`);
        }
      }

      // Determine if it's a short based on duration
      if (isShort === null) {
        if (totalSeconds > 0 && totalSeconds <= 180) {
          isShort = true;
        } else {
          isShort = false;
        }
      }

      if (channel.isShortsOnly && !isShort) {
        continue;
      }
      if (isShortVal === true && !isShort) {
        continue;
      }

      const [video, created] = await ChannelVideo.findOrCreate({
        where: { youtubeVideoId },
        defaults: {
          channelId: channel.id,
          title,
          thumbnailUrl,
          publishedAt,
          isAvailable: true,
          liveBroadcastContent,
          scheduledStartTime,
          isShort,
          durationStr,
          totalSeconds,
          viewCount,
        },
      });

      if (!created) {
        await video.update({
          title,
          thumbnailUrl,
          publishedAt,
          isAvailable: true,
          liveBroadcastContent,
          scheduledStartTime,
          isShort,
          durationStr,
          totalSeconds,
          viewCount,
        });
      } else {
        newVideosCount++;
      }
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken && !reachedAlreadySynced);

  return newVideosCount;
}

/**
 * Sync videos for a single YouTube channel supporting source ('channel' vs 'shorts-only') and fallback
 * @param {object} channel - Sequelize Channel instance
 */
async function syncChannel(channel, { skipAlerts = false, maxPages = 0 } = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.warn('YOUTUBE_API_KEY is not configured in environment variables.');
    throw new Error('YOUTUBE_API_KEY is missing');
  }

  channel.lastSyncStatus = 'syncing';
  await channel.save();

  await refreshChannelMetadata(channel);

  const playlistIds = getPlaylistIds(channel.youtubeChannelId);
  const uploadsPlaylistId = channel.uploadsPlaylistId || playlistIds.uploads;

  const lastSyncedAtTime = channel.lastSyncedAt ? new Date(channel.lastSyncedAt).getTime() : 0;
  let totalNewVideos = 0;

  try {
    const source = channel.source || (channel.isShortsOnly ? 'shorts-only' : 'channel');

    if (source === 'shorts-only') {
      try {
        const added = await processPlaylistItems(channel, playlistIds.shortsOnly, true, apiKey, lastSyncedAtTime, maxPages);
        totalNewVideos += added;
      } catch (err) {
        logger.warn(`Shorts-only playlist ${playlistIds.shortsOnly} failed for channel ${channel.name}: ${err.message}. Trying uploads fallback.`);
        totalNewVideos += await syncViaUploadsFallback(channel, uploadsPlaylistId, apiKey, lastSyncedAtTime, true, 50);
      }
    } else {
      let longSuccess = false;
      let shortsSuccess = false;

      try {
        const addedLong = await processPlaylistItems(channel, playlistIds.longOnly, false, apiKey, lastSyncedAtTime, maxPages);
        totalNewVideos += addedLong;
        longSuccess = true;
      } catch (err) {
        logger.warn(`Long-only playlist ${playlistIds.longOnly} failed for channel ${channel.name}: ${err.message}`);
      }

      try {
        const addedShorts = await processPlaylistItems(channel, playlistIds.shortsOnly, true, apiKey, lastSyncedAtTime, maxPages);
        totalNewVideos += addedShorts;
        shortsSuccess = true;
      } catch (err) {
        logger.warn(`Shorts playlist ${playlistIds.shortsOnly} failed for channel ${channel.name}: ${err.message}`);
      }

      if (!longSuccess && !shortsSuccess) {
        logger.info(`Both UULF and UUSH playlists failed or empty for channel ${channel.name}. Triggering uploads fallback.`);
        totalNewVideos += await syncViaUploadsFallback(channel, uploadsPlaylistId, apiKey, lastSyncedAtTime, null, 50);
      }
    }

    channel.lastSyncedAt = new Date();
    channel.lastSyncStatus = 'ok';
    channel.lastSyncError = null;
    await channel.save();

    logger.info(`Channel ${channel.name} synced successfully: ${totalNewVideos} new videos added.`);
    return totalNewVideos;
  } catch (err) {
    logger.error(`Error syncing channel ${channel.name}: ${err.message}`);
    channel.lastSyncStatus = 'error';
    channel.lastSyncError = err.message;
    await channel.save();
    throw err;
  }
}

/**
 * Fallback sync via uploads playlist (UU)
 */
async function syncViaUploadsFallback(channel, uploadsPlaylistId, apiKey, lastSyncedAtTime, forcedIsShort, maxVideosLimit = 50) {
  let pageToken = '';
  let newVideosCount = 0;
  let processedCount = 0;
  let reachedAlreadySynced = false;

  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems`;
    const params = {
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      key: apiKey,
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    const response = await axios.get(url, { params, timeout: 10000 });
    const items = response.data.items || [];
    if (items.length === 0) break;

    const videoIds = items.map(item => item.snippet?.resourceId?.videoId).filter(Boolean);
    if (videoIds.length === 0) break;

    const videosDetailsRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${videoIds.join(',')}&key=${apiKey}`, { timeout: 10000 });
    trackQuota(1);

    const videoDetailsMap = new Map();
    for (const videoItem of (videosDetailsRes.data.items || [])) {
      videoDetailsMap.set(videoItem.id, videoItem);
    }

    for (const item of items) {
      if (processedCount >= maxVideosLimit) {
        break;
      }

      const snippet = item.snippet;
      if (!snippet || !snippet.resourceId || !snippet.resourceId.videoId) continue;

      const youtubeVideoId = snippet.resourceId.videoId;
      const videoData = videoDetailsMap.get(youtubeVideoId);

      const title = videoData?.snippet?.title || snippet.title || 'Untitled Video';
      const thumbnailUrl =
        videoData?.snippet?.thumbnails?.high?.url ||
        snippet.thumbnails?.high?.url ||
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.default?.url ||
        `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`;
      const publishedAt = videoData?.snippet?.publishedAt ? new Date(videoData.snippet.publishedAt) : (snippet.publishedAt ? new Date(snippet.publishedAt) : new Date());
      const liveBroadcastContent = videoData?.snippet?.liveBroadcastContent || 'none';
      const scheduledStartTime = videoData?.liveStreamingDetails?.scheduledStartTime ? new Date(videoData.liveStreamingDetails.scheduledStartTime) : null;

      if (lastSyncedAtTime && publishedAt.getTime() <= lastSyncedAtTime) {
        reachedAlreadySynced = true;
        break;
      }

      let isShort = forcedIsShort;
      let durationStr = videoData?.contentDetails?.duration || '';
      let totalSeconds = 0;
      let viewCount = videoData?.statistics?.viewCount ? parseInt(videoData.statistics.viewCount, 10) : 0;

      if (durationStr) {
        try {
          const durationObj = parse(durationStr);
          totalSeconds = (durationObj.hours || 0) * 3600 + (durationObj.minutes || 0) * 60 + (durationObj.seconds || 0);
        } catch (e) {
          logger.warn(`Could not parse duration for video ${youtubeVideoId} in fallback: ${e.message}`);
        }
      }

      if (isShort === null) {
        processedCount++;
        isShort = totalSeconds > 0 && totalSeconds <= 180;
      }

      if (!isShort) {
        continue;
      }

      const [video, created] = await ChannelVideo.findOrCreate({
        where: { youtubeVideoId },
        defaults: {
          channelId: channel.id,
          title,
          thumbnailUrl,
          publishedAt,
          isAvailable: true,
          liveBroadcastContent,
          scheduledStartTime,
          isShort,
          durationStr,
          totalSeconds,
          viewCount,
        },
      });

      if (!created) {
        await video.update({
          title,
          thumbnailUrl,
          publishedAt,
          isAvailable: true,
          liveBroadcastContent,
          scheduledStartTime,
          isShort,
          durationStr,
          totalSeconds,
          viewCount,
        });
      } else {
        newVideosCount++;
      }
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken && !reachedAlreadySynced && processedCount < maxVideosLimit);

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
        const added = await syncChannel(channel, { skipAlerts: true });
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

/**
 * Priority 1: Check health of all stored videos in batches of 50.
 */
async function checkVideoHealth() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.warn('YOUTUBE_API_KEY is not configured for checkVideoHealth.');
    return;
  }

  logger.info('Starting scheduled video health check...');
  try {
    const videos = await ChannelVideo.findAll({
      attributes: ['id', 'youtubeVideoId', 'isAvailable'],
    });

    if (videos.length === 0) return;

    const batches = [];
    for (let i = 0; i < videos.length; i += 50) {
      batches.push(videos.slice(i, i + 50));
    }

    for (const batch of batches) {
      const ids = batch.map(v => v.youtubeVideoId).join(',');
      try {
        const url = `https://www.googleapis.com/youtube/v3/videos`;
        const response = await axios.get(url, {
          params: {
            part: 'status',
            id: ids,
            key: apiKey,
          },
          timeout: 10000,
        });

        const returnedItems = response.data.items || [];
        const returnedMap = new Map();
        for (const item of returnedItems) {
          const privacy = item.status?.privacyStatus;
          const isPublic = privacy === 'public';
          returnedMap.set(item.id, isPublic);
        }

        for (const v of batch) {
          const isPublic = returnedMap.get(v.youtubeVideoId);
          const available = isPublic === true;
          if (v.isAvailable !== available) {
            await ChannelVideo.update({ isAvailable: available }, { where: { id: v.id } });
          }
        }
      } catch (batchErr) {
        logger.error(`Error checking batch video health: ${batchErr.message}`);
      }
    }
    logger.info('Video health check completed successfully.');
  } catch (err) {
    logger.error(`Error in checkVideoHealth: ${err.message}`);
  }
}

async function getVideoLiveStatus(videoId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !videoId) return null;

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,liveStreamingDetails',
        id: videoId,
        key: apiKey,
      },
      timeout: 10000,
    });
    trackQuota(1);

    const items = response.data.items || [];
    if (items.length === 0) return null;

    const item = items[0];
    const snippet = item.snippet || {};
    const liveDetails = item.liveStreamingDetails || {};

    return {
      videoId: item.id,
      title: snippet.title || 'Untitled Video',
      thumbnailUrl:
        snippet.thumbnails?.high?.url ||
        snippet.thumbnails?.medium?.url ||
        snippet.thumbnails?.default?.url ||
        `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      liveBroadcastContent: snippet.liveBroadcastContent || 'none',
      scheduledStartTime: liveDetails.scheduledStartTime ? new Date(liveDetails.scheduledStartTime) : null,
      actualStartTime: liveDetails.actualStartTime ? new Date(liveDetails.actualStartTime) : null,
      actualEndTime: liveDetails.actualEndTime ? new Date(liveDetails.actualEndTime) : null,
    };
  } catch (err) {
    logger.error(`Error in getVideoLiveStatus for video ${videoId}: ${err.message}`);
    return null;
  }
}

function triggerLiveTransition(transitionData) {
  logger.info(`[LIVE TRANSITION STUB] Channel "${transitionData.channel.name}" went LIVE! Video ID: ${transitionData.videoId}`);
  liveEmitter.emit('upcomingToLive', transitionData);
}

async function runPhaseADiscovery(channel) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !channel.uploadsPlaylistId) return;

  const now = Date.now();
  if (channel.lastLiveCheckAt && (now - new Date(channel.lastLiveCheckAt).getTime() < 2 * 3600 * 1000)) {
    return;
  }

  try {
    const playlistRes = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: {
        part: 'snippet',
        playlistId: channel.uploadsPlaylistId,
        maxResults: 10,
        key: apiKey,
      },
      timeout: 10000,
    });
    trackQuota(1);

    const playlistItems = playlistRes.data.items || [];
    if (playlistItems.length === 0) {
      channel.lastLiveCheckAt = new Date();
      await channel.save();
      return;
    }

    const videoIds = playlistItems
      .map(item => item.snippet?.resourceId?.videoId)
      .filter(Boolean)
      .join(',');

    if (!videoIds) return;

    const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,liveStreamingDetails',
        id: videoIds,
        key: apiKey,
      },
      timeout: 10000,
    });
    trackQuota(1);

    const videoItems = videosRes.data.items || [];
    let foundUpcoming = null;

    for (const vItem of videoItems) {
      const broadcastContent = vItem.snippet?.liveBroadcastContent;
      if (broadcastContent === 'upcoming') {
        foundUpcoming = {
          videoId: vItem.id,
          scheduledStartTime: vItem.liveStreamingDetails?.scheduledStartTime ? new Date(vItem.liveStreamingDetails.scheduledStartTime) : null,
        };
        break;
      }
    }

    if (foundUpcoming) {
      channel.upcomingVideoId = foundUpcoming.videoId;
      channel.scheduledStartTime = foundUpcoming.scheduledStartTime;
      channel.discoveredAt = new Date();
      channel.lastLiveCheckAt = new Date();
      await channel.save();
    } else {
      if (channel.upcomingVideoId || channel.scheduledStartTime) {
        channel.upcomingVideoId = null;
        channel.scheduledStartTime = null;
        channel.discoveredAt = null;
      }
      channel.lastLiveCheckAt = new Date();
      await channel.save();
    }
  } catch (err) {
    logger.error(`Error in Phase A discovery for channel ${channel.name}: ${err.message}`);
  }
}

async function processLiveChannelState(channel) {
  const now = new Date();

  if (channel.isCurrentlyLive && channel.liveVideoId) {
    if (channel.lastLiveCheckAt && (now.getTime() - new Date(channel.lastLiveCheckAt).getTime() < 2 * 60 * 1000)) {
      return;
    }

    const status = await getVideoLiveStatus(channel.liveVideoId);
    if (!status) return;

    channel.lastLiveCheckAt = now;

    if (status.liveBroadcastContent === 'none' || status.actualEndTime) {
      channel.isCurrentlyLive = false;
      channel.liveVideoId = null;
      channel.liveStartedAt = null;
      channel.upcomingVideoId = null;
      channel.scheduledStartTime = null;
      channel.discoveredAt = null;
      await channel.save();

      try {
        await ChannelVideo.findOrCreate({
          where: { youtubeVideoId: status.videoId },
          defaults: {
            channelId: channel.id,
            title: status.title,
            thumbnailUrl: status.thumbnailUrl,
            publishedAt: status.actualStartTime || now,
            isAvailable: true,
            isShort: false,
          },
        });
      } catch (vodErr) {
        logger.error(`Error refreshing VOD metadata for ${status.videoId}: ${vodErr.message}`);
      }
    } else {
      await channel.save();
    }
    return;
  }

  if (channel.upcomingVideoId) {
    let scheduledTime = channel.scheduledStartTime ? new Date(channel.scheduledStartTime) : null;
    if (scheduledTime) {
      const diffMs = scheduledTime - now;
      const diffMins = diffMs / 60000;
      if (diffMins > 15) return;
      if (diffMins < -45) {
        channel.upcomingVideoId = null;
        channel.scheduledStartTime = null;
        channel.discoveredAt = null;
        channel.lastLiveCheckAt = now;
        await channel.save();
        return;
      }
    }

    const status = await getVideoLiveStatus(channel.upcomingVideoId);
    if (!status) return;

    channel.lastLiveCheckAt = now;

    if (status.liveBroadcastContent === 'live' || status.actualStartTime) {
      channel.isCurrentlyLive = true;
      channel.liveVideoId = channel.upcomingVideoId;
      channel.liveStartedAt = status.actualStartTime || now;
      channel.lastNotifiedVideoId = channel.upcomingVideoId;
      await channel.save();

      triggerLiveTransition({
        channel,
        videoId: channel.liveVideoId,
        scheduledStartTime: channel.scheduledStartTime,
        liveStartedAt: channel.liveStartedAt,
      });
    } else {
      await channel.save();
    }
    return;
  }

  await runPhaseADiscovery(channel);
}

async function checkLiveAndUpcomingStatus() {
  try {
    const optInChannels = await Channel.findAll({
      where: { isActive: true, checkLiveStatus: true },
    });
    for (const channel of optInChannels) {
      if (!channel.youtubeChannelId || !channel.uploadsPlaylistId) continue;
      await processLiveChannelState(channel);
    }
  } catch (err) {
    logger.error(`Error in checkLiveAndUpcomingStatus: ${err.message}`);
  }
}

// Register cron jobs
if (process.env.DISABLE_CRONS !== 'true') {
  try {
    cron.schedule('0 * * * *', () => { syncAllActiveChannels(); });
    cron.schedule('0 */6 * * *', () => { refreshMetadataForAllChannels(); });
    cron.schedule('0 3 * * *', () => { checkVideoHealth(); });
    cron.schedule('* * * * *', () => { checkLiveAndUpcomingStatus(); });
  } catch (err) {
    logger.error(`Failed to schedule channel sync cron jobs: ${err.message}`);
  }
}

module.exports = {
  getPlaylistIds,
  syncChannel,
  syncAllActiveChannels,
  refreshChannelMetadata,
  refreshMetadataForAllChannels,
  checkVideoHealth,
  checkLiveAndUpcomingStatus,
  runPhaseADiscovery,
  getVideoLiveStatus,
  liveEmitter,
  triggerLiveTransition,
};