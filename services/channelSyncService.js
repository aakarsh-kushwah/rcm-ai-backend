const axios = require('axios');
const cron = require('node-cron');
const EventEmitter = require('events');
const { Channel, ChannelVideo } = require('../models');
const logger = require('../utils/logger');

// Event emitter for live transitions (Part 3 attaches here)
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
 * Sync videos for a single YouTube channel from its uploads playlist
 * @param {object} channel - Sequelize Channel instance
 */
async function syncChannel(channel) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.warn('YOUTUBE_API_KEY is not configured in environment variables.');
    throw new Error('YOUTUBE_API_KEY is missing');
  }

  // Set syncing status
  channel.lastSyncStatus = 'syncing';
  await channel.save();

  // Refresh channel metadata and statistics first
  await refreshChannelMetadata(channel);

  const playlistId = channel.uploadsPlaylistId;
  if (!playlistId) {
    const err = new Error(`Channel ${channel.name} (${channel.id}) has no uploadsPlaylistId`);
    channel.lastSyncStatus = 'error';
    channel.lastSyncError = err.message;
    await channel.save();
    throw err;
  }

  let pageToken = '';
  let newVideosCount = 0;
  let reachedAlreadySynced = false;
  const lastSyncedAtTime = channel.lastSyncedAt ? new Date(channel.lastSyncedAt).getTime() : 0;

  try {
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

      const videosDetailsRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoIds.join(',')}&key=${apiKey}`, { timeout: 10000 });
      trackQuota(videoIds.length > 0 ? 1 : 0); // Each videos.list call costs 1 unit.

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
            isAvailable: true,
            liveBroadcastContent,
            scheduledStartTime,
          },
        });

        if (!created) {
          // If video exists, update its details in case live status or title changed
          await video.update({
            title,
            thumbnailUrl,
            publishedAt,
            isAvailable: true,
            liveBroadcastContent,
            scheduledStartTime,
          });
        } else {
          newVideosCount++;
        }
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken && !reachedAlreadySynced);

    // Update success status and timestamp
    channel.lastSyncedAt = new Date();
    channel.lastSyncStatus = 'ok';
    channel.lastSyncError = null;
    await channel.save();

    logger.info(`Channel ${channel.name} synced successfully: ${newVideosCount} new videos added.`);
    return newVideosCount;
  } catch (err) {
    logger.error(`Error syncing channel ${channel.name}: ${err.message}`);
    channel.lastSyncStatus = 'error';
    channel.lastSyncError = err.message;
    await channel.save();
    throw err;
  }
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

/**
 * Priority 1: Check health of all stored videos in batches of 50.
 * Marks isAvailable = false if video is deleted/private/unavailable.
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
          const available = isPublic === true; // true only if returned and public
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

/**
 * Cheap status-check helper: use videos.list(id=X, part=snippet,liveStreamingDetails) (1 unit/call)
 * @param {string} videoId 
 * @returns {object|null} video details status
 */
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
      liveBroadcastContent: snippet.liveBroadcastContent || 'none', // 'none', 'upcoming', 'live'
      scheduledStartTime: liveDetails.scheduledStartTime ? new Date(liveDetails.scheduledStartTime) : null,
      actualStartTime: liveDetails.actualStartTime ? new Date(liveDetails.actualStartTime) : null,
      actualEndTime: liveDetails.actualEndTime ? new Date(liveDetails.actualEndTime) : null,
    };
  } catch (err) {
    logger.error(`Error in getVideoLiveStatus for video ${videoId}: ${err.message}`);
    return null;
  }
}

/**
 * Trigger point for upcoming -> live transition (Part 3 attaches here)
 */
function triggerLiveTransition(transitionData) {
  logger.info(`[LIVE TRANSITION STUB] Channel "${transitionData.channel.name}" went LIVE! Video ID: ${transitionData.videoId}, Scheduled Start: ${transitionData.scheduledStartTime}, Live Started At: ${transitionData.liveStartedAt}`);
  liveEmitter.emit('upcomingToLive', transitionData);
}

// Part 3: Notification Listener on liveEmitter with deduplication (lastNotifiedVideoId) and Titan Broadcast call
liveEmitter.on('upcomingToLive', async ({ channel, videoId, scheduledStartTime, liveStartedAt }) => {
  try {
    const freshChannel = await Channel.findByPk(channel.id);
    if (!freshChannel) return;

    if (freshChannel.lastNotifiedVideoId === videoId) {
      logger.info(`[Live Notification] Already notified for video ${videoId} on channel ${channel.name}. Skipping.`);
      return;
    }

    freshChannel.lastNotifiedVideoId = videoId;
    await freshChannel.save();

    const { broadcastNotification } = require('../controllers/notificationController');
    const result = await broadcastNotification({
      title: "RCM Gurukul is LIVE now",
      body: "TC Sir's session has started — tap to join",
      actionUrl: `https://www.youtube.com/watch?v=${videoId}`,
      dataPayload: {
        videoId: videoId,
        channelId: channel.id,
        type: 'live_stream',
        url: `https://www.youtube.com/watch?v=${videoId}`
      }
    });

    logger.info(`✅ [Live Notification Result] Success: ${result.successCount}, Failures: ${result.failureCount} for video ${videoId}`);
  } catch (err) {
    logger.error(`🔥 Error in upcomingToLive listener notification: ${err.message}`);
  }
});

/**
 * Phase A (Discovery): Check uploads playlist for a new video with liveBroadcastContent === 'upcoming'
 * Avoids search.list (1 unit for playlistItems.list + 1 unit for batch videos.list)
 */
async function runPhaseADiscovery(channel) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !channel.uploadsPlaylistId) return;

  // Throttle Phase A check if checked recently (e.g. within last 2 hours)
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
      logger.info(`[Phase A Discovery] Upcoming stream detected for channel "${channel.name}": videoId=${foundUpcoming.videoId}, scheduledTime=${foundUpcoming.scheduledStartTime}`);
    } else {
      // If no upcoming video is found, clear any stale upcoming data
      if (channel.upcomingVideoId || channel.scheduledStartTime) {
        logger.info(`[Phase A Discovery] No new upcoming stream found for channel "${channel.name}". Clearing stale upcoming video data.`);
        channel.upcomingVideoId = null;
        channel.scheduledStartTime = null;
        channel.discoveredAt = null;
      }
      channel.lastLiveCheckAt = new Date();
      await channel.save();
      logger.info(`[Phase A Discovery] No upcoming stream found in recent uploads for channel "${channel.name}".`);
    }
  } catch (err) {
    logger.error(`Error in Phase A discovery for channel ${channel.name}: ${err.message}`);
  }
}

/**
 * Phase B (Pre-live Watch) & Phase C (Live Tracking) handler per channel
 */
async function processLiveChannelState(channel) {
  const now = new Date();

  // 1. Phase C: Live Tracking (if currently live)
  if (channel.isCurrentlyLive && channel.liveVideoId) {
    // Poll every 2-3 minutes
    if (channel.lastLiveCheckAt && (now.getTime() - new Date(channel.lastLiveCheckAt).getTime() < 2 * 60 * 1000)) {
      return;
    }

    const status = await getVideoLiveStatus(channel.liveVideoId);
    if (!status) return;

    channel.lastLiveCheckAt = now;

    // Detect end: flip to 'none' or actualEndTime present
    if (status.liveBroadcastContent === 'none' || status.actualEndTime) {
      logger.info(`[Phase C Live Tracking] Stream ENDED for channel "${channel.name}", videoId=${channel.liveVideoId}`);
      
      // Clear live state so Phase A can discover next stream fresh
      channel.isCurrentlyLive = false;
      channel.liveVideoId = null;
      channel.liveStartedAt = null;
      channel.upcomingVideoId = null;
      channel.scheduledStartTime = null;
      channel.discoveredAt = null;
      await channel.save();

      // Trigger metadata refresh on finalized VOD video
      try {
        await ChannelVideo.findOrCreate({
          where: { youtubeVideoId: status.videoId },
          defaults: {
            channelId: channel.id,
            title: status.title,
            thumbnailUrl: status.thumbnailUrl,
            publishedAt: status.actualStartTime || now,
            isAvailable: true,
          },
        });
        await ChannelVideo.update(
          { title: status.title, thumbnailUrl: status.thumbnailUrl, isAvailable: true },
          { where: { youtubeVideoId: status.videoId } }
        );
        logger.info(`[Phase C Live Tracking] Metadata refreshed for finalized VOD video ${status.videoId}`);
      } catch (vodErr) {
        logger.error(`Error refreshing VOD metadata for ${status.videoId}: ${vodErr.message}`);
      }
    } else {
      logger.info(`[Phase C Live Tracking] Stream still live for channel "${channel.name}", videoId=${channel.liveVideoId}`);
      await channel.save();
    }
    return;
  }

  // 2. Phase B: Pre-live Watch (if upcomingVideoId is known)
  if (channel.upcomingVideoId) {
    let scheduledTime = channel.scheduledStartTime ? new Date(channel.scheduledStartTime) : null;

    if (!scheduledTime && channel.lastKnownLiveStartTime) {
      const lastKnown = new Date(channel.lastKnownLiveStartTime);
      const todayAtLastKnown = new Date();
      todayAtLastKnown.setHours(lastKnown.getHours(), lastKnown.getMinutes(), 0, 0);
      if (now.getTime() - todayAtLastKnown.getTime() > 2 * 3600 * 1000) {
        todayAtLastKnown.setDate(todayAtLastKnown.getDate() + 1);
      }
      scheduledTime = todayAtLastKnown;
    }

    if (scheduledTime) {
      const diffMs = scheduledTime - now;
      const diffMins = diffMs / 60000;

      // If more than 15 mins before scheduled time, wait
      if (diffMins > 15) {
        return;
      }

      // If not live by 45 mins past scheduled time, back off / give up for today
      if (diffMins < -45) {
        logger.info(`[Phase B Pre-live Watch] Upcoming stream ${channel.upcomingVideoId} missed / 45+ mins past scheduled time. Resetting for Phase A discovery.`);
        channel.upcomingVideoId = null;
        channel.scheduledStartTime = null;
        channel.discoveredAt = null;
        channel.lastLiveCheckAt = now;
        await channel.save();
        return;
      }

      // Within 15 min before to 45 min after scheduled time, poll every 1 minute
      if (channel.lastLiveCheckAt && (now.getTime() - new Date(channel.lastLiveCheckAt).getTime() < 55 * 1000)) {
        return;
      }
    } else {
      // Fallback when no scheduledStartTime and no lastKnownLiveStartTime: poll every 5 minutes
      if (channel.lastLiveCheckAt && (now.getTime() - new Date(channel.lastLiveCheckAt).getTime() < 5 * 60 * 1000)) {
        return;
      }
    }

    const status = await getVideoLiveStatus(channel.upcomingVideoId);
    if (!status) return;

    channel.lastLiveCheckAt = now;

    // Watch for flip to 'live'
    if (status.liveBroadcastContent === 'live' || status.actualStartTime) {
      logger.info(`[Phase B -> C Transition] STREAM GOING LIVE! Channel "${channel.name}", videoId=${channel.upcomingVideoId}`);

      channel.isCurrentlyLive = true;
      channel.liveVideoId = channel.upcomingVideoId;
      channel.liveStartedAt = status.actualStartTime || now;
      channel.lastNotifiedVideoId = channel.upcomingVideoId;
      channel.lastKnownLiveStartTime = status.actualStartTime || now; // Store for future fallback
      await channel.save();

      // Trigger upcoming -> live transition stub & event
      // Part 3: Notification and Frontend Display Trigger
      try {
        if (channel.lastNotifiedVideoId !== channel.liveVideoId) {
          const notificationController = require('../controllers/notificationController');
          const notificationPayload = {
            title: "RCM Gurukul is LIVE now",
            body: `TC Sir's session has started — tap to join!`, // Customize as needed
            actionUrl: `/channels/${channel.id}/videos?videoId=${channel.liveVideoId}`, // Deep link to the specific video
            dataPayload: { // Custom data for frontend
              channelId: channel.id,
              videoId: channel.liveVideoId,
              type: 'live_stream',
            },
          };

          const { successCount, failureCount } = await notificationController.sendTitanBroadcast(null, null, notificationPayload, true);
          logger.info(`[Phase B -> C Transition] Live notification sent. Success: ${successCount}, Failure: ${failureCount}`);
          channel.lastNotifiedVideoId = channel.liveVideoId;
          await channel.save(); // Save immediately after notifying
        }
      } catch (notifErr) {
        logger.error(`Error sending live notification for channel ${channel.name}: ${notifErr.message}`);
      }

      triggerLiveTransition({
        channel,
        videoId: channel.liveVideoId,
        scheduledStartTime: channel.scheduledStartTime,
        liveStartedAt: channel.liveStartedAt,
      });
    } else {
      logger.info(`[Phase B Pre-live Watch] Channel "${channel.name}" video ${channel.upcomingVideoId} checked. Status: ${status.liveBroadcastContent}. Scheduled: ${channel.scheduledStartTime || 'None (Fallback active)'}`);
      await channel.save();
    }
    return;
  }

  // 3. Phase A: Discovery (if no upcoming video known)
  await runPhaseADiscovery(channel);
}

/**
 * Priority 4 / Live Detection: Check live and upcoming status across opt-in channels
 */
async function checkLiveAndUpcomingStatus() {
  try {
    const optInChannels = await Channel.findAll({
      where: { isActive: true, checkLiveStatus: true },
    });

    if (optInChannels.length === 0) return;

    for (const channel of optInChannels) {
      if (!channel.youtubeChannelId || !channel.uploadsPlaylistId) continue;
      await processLiveChannelState(channel);
    }
  } catch (err) {
    logger.error(`Error in checkLiveAndUpcomingStatus: ${err.message}`);
  }
}

// Register cron jobs
try {
  // Priority 3: Hourly sync for new videos
  cron.schedule('0 * * * *', () => {
    syncAllActiveChannels();
  });
  logger.info('YouTube channel sync cron job scheduled successfully (hourly - Priority 3).');

  // Channel metadata & statistics refresh every 6 hours
  cron.schedule('0 */6 * * *', () => {
    refreshMetadataForAllChannels();
  });
  logger.info('YouTube channel metadata refresh cron job scheduled successfully (every 6 hours).');

  // Priority 1: Daily video health check (e.g. 3:00 AM)
  cron.schedule('0 3 * * *', () => {
    checkVideoHealth();
  });
  logger.info('YouTube video health check cron job scheduled successfully (daily at 03:00).');

  // Priority 4 / Live Detection: Run every 1 minute to support Phase A, B, and C polling intervals
  cron.schedule('* * * * *', () => {
    checkLiveAndUpcomingStatus();
  });
  logger.info('YouTube live detection cron job scheduled successfully (every 1 minute for Phase A/B/C polling).');

  // TC Sir Gurukul Morning Live Notification (Targeted Cron running every minute between 6:15 AM - 7:00 AM IST)
  cron.schedule('*/1 6-7 * * *', async () => {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Calcutta' }));
    const istHour = istTime.getHours();
    const istMinute = istTime.getMinutes();

    // Target window: 6:15 AM to 7:00 AM IST
    if (istHour === 6 && istMinute >= 15 && istMinute <= 59) {
      try {
        const rcmWorldChannel = await Channel.findOne({
          where: {
            isActive: true,
          }
        });

        if (rcmWorldChannel) {
          logger.info(`[Gurukul Morning Cron] Checking RCM World for live status at ${istHour}:${istMinute} IST...`);
          await processLiveChannelState(rcmWorldChannel);
        }
      } catch (cronErr) {
        logger.error(`Error in Gurukul Morning Live Cron: ${cronErr.message}`);
      }
    }
  });
  logger.info('TC Sir Gurukul Morning Live Notification cron scheduled successfully (6:15 AM - 7:00 AM IST window).');
} catch (err) {
  logger.error(`Failed to schedule channel sync cron jobs: ${err.message}`);
}

module.exports = {
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
