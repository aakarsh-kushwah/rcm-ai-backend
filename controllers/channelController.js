const axios = require('axios');
const asyncHandler = require('express-async-handler');
const { Channel, ChannelVideo } = require('../models');
const { syncChannel, refreshChannelMetadata } = require('../services/channelSyncService');
const logger = require('../utils/logger');

/**
 * Helper to parse YouTube input into handle or channel ID
 */
function parseYouTubeInput(input) {
  if (!input || typeof input !== 'string') return { type: null, value: null };
  const trimmed = input.trim();

  // If starts with UC... (channel ID)
  if (trimmed.startsWith('UC') && trimmed.length === 24) {
    return { type: 'id', value: trimmed };
  }

  // If handle like @RCMIndia
  if (trimmed.startsWith('@')) {
    return { type: 'handle', value: trimmed.substring(1) };
  }

  // URL parsing
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname;

    if (pathname.startsWith('/@')) {
      const handle = pathname.split('/')[1].substring(1);
      return { type: 'handle', value: handle };
    }

    if (pathname.startsWith('/channel/')) {
      const id = pathname.split('/')[2];
      return { type: 'id', value: id };
    }

    if (pathname.startsWith('/c/') || pathname.startsWith('/user/')) {
      // Custom name / user
      const name = pathname.split('/')[2];
      return { type: 'handle', value: name };
    }
  } catch (e) {
    // Not a valid URL, treat as handle or search term if needed
    if (!trimmed.includes(' ')) {
      const handle = trimmed.startsWith('@') ? trimmed.substring(1) : trimmed;
      return { type: 'handle', value: handle };
    }
  }

  return { type: 'handle', value: trimmed.startsWith('@') ? trimmed.substring(1) : trimmed };
}

/**
 * Helper to calculate next 6:30 AM IST Gurukul session for RCM World (id: 2)
 */
function getNextGurukulSchedule() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  const istTime = new Date(utcTime + istOffset);

  const year = istTime.getFullYear();
  const month = istTime.getMonth();
  const day = istTime.getDate();
  const hour = istTime.getHours();
  const minute = istTime.getMinutes();
  const totalMins = hour * 60 + minute;

  // Gurukul is daily at 6:30 AM IST (390 mins). Concludes at 7:30 AM IST (450 mins).
  // If current IST time is past 7:30 AM IST (> 450 mins), next session is tomorrow 6:30 AM IST.
  // Otherwise, today 6:30 AM IST.
  const istTargetDate = new Date(Date.UTC(year, month, day, 1, 0, 0, 0)); // 01:00 UTC = 6:30 AM IST
  if (totalMins > 450) {
    istTargetDate.setDate(istTargetDate.getDate() + 1);
  }
  return istTargetDate;
}

/**
 * @desc    Resolve YouTube channel from input (Preview step)
 * @route   POST /api/channels/resolve
 * @access  Admin
 */
exports.resolveChannel = asyncHandler(async (req, res) => {
  const { input } = req.body;
  if (!input) {
    return res.status(400).json({ success: false, message: 'Channel input (URL or handle) is required.' });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'YOUTUBE_API_KEY is not configured on server.' });
  }

  const parsed = parseYouTubeInput(input);
  if (!parsed.value) {
    return res.status(400).json({ success: false, message: 'Could not parse channel input.' });
  }

  let ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics,brandingSettings&key=${apiKey}`;
  if (parsed.type === 'id') {
    ytUrl += `&id=${parsed.value}`;
  } else {
    // YouTube Data API channels.list supports forHandle parameter (with or without @)
    ytUrl += `&forHandle=${parsed.value}`;
  }

  try {
    const response = await axios.get(ytUrl, { timeout: 10000 });
    const items = response.data.items || [];

    // Fallback: if forHandle failed or yielded 0 items, try searching or querying with username/q if needed, or error
    if (items.length === 0 && parsed.type === 'handle') {
      // Try search endpoint as fallback for custom names if forHandle doesn't match directly
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(
        parsed.value
      )}&key=${apiKey}&maxResults=1`;
      const searchRes = await axios.get(searchUrl, { timeout: 10000 });
      const searchItems = searchRes.data.items || [];
      if (searchItems.length > 0) {
        const channelId = searchItems[0].snippet.channelId;
        const detailsUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics,brandingSettings&id=${channelId}&key=${apiKey}`;
        const detailsRes = await axios.get(detailsUrl, { timeout: 10000 });
        if (detailsRes.data.items && detailsRes.data.items.length > 0) {
          items.push(detailsRes.data.items[0]);
        }
      }
    }

    if (items.length === 0) {
      return res.status(404).json({ success: false, message: 'YouTube channel not found. Please check the handle or URL.' });
    }

    const channelData = items[0];
    const youtubeChannelId = channelData.id;
    const snippet = channelData.snippet || {};
    const contentDetails = channelData.contentDetails || {};
    const statistics = channelData.statistics || {};
    const brandingSettings = channelData.brandingSettings || {};

    const name = snippet.title || 'Unknown Channel';
    const handle = snippet.customUrl || `@${parsed.value}`;
    const logoUrl =
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      '';
    const bannerUrl = brandingSettings.image?.bannerExternalUrl || '';
    const description = snippet.description || '';
    const uploadsPlaylistId = contentDetails.relatedPlaylists?.uploads || '';
    const subscriberCount = statistics.subscriberCount ? parseInt(statistics.subscriberCount, 10) : 0;
    const videoCount = statistics.videoCount ? parseInt(statistics.videoCount, 10) : 0;
    const viewCount = statistics.viewCount ? parseInt(statistics.viewCount, 10) : 0;
    const joinedDate = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
    const country = snippet.country || null;
    const itemCount = videoCount; // For consistency, though we're now storing videoCount directly

    if (!uploadsPlaylistId) {
      return res.status(400).json({ success: false, message: 'Could not retrieve uploads playlist for this YouTube channel.' });
    }

    res.status(200).json({
      success: true,
      data: {
        youtubeChannelId,
        handle,
        name,
        logoUrl,
        bannerUrl,
        description,
        subscriberCount,
        videoCount,
        viewCount,
        joinedDate,
        country,
        uploadsPlaylistId,
        itemCount, // Still include for existing frontend logic that might use it
      },
    });
  } catch (err) {
    logger.error(`YouTube API Error in resolveChannel: ${err.message}`);
    res.status(500).json({
      success: false,
      message: 'Failed to resolve YouTube channel.',
      error: err.response?.data?.error?.message || err.message,
    });
  }
});

/**
 * @desc    Create Channel and trigger initial sync
 * @route   POST /api/channels
 * @access  Admin
 */
exports.createChannel = asyncHandler(async (req, res) => {
  const { youtubeChannelId, handle, name, logoUrl, bannerUrl, description, subscriberCount, videoCount, viewCount, joinedDate, country, uploadsPlaylistId } = req.body;

  if (!youtubeChannelId || !name || !uploadsPlaylistId) {
    return res.status(400).json({ success: false, message: 'Missing required channel parameters.' });
  }

  // Check if channel already exists
  let channel = await Channel.findOne({ where: { youtubeChannelId } });
  if (channel) {
    return res.status(400).json({ success: false, message: 'Channel already added to database.' });
  }

  channel = await Channel.create({
    youtubeChannelId,
    handle: handle || '',
    name,
    logoUrl: logoUrl || '',
    bannerUrl: bannerUrl || '',
    description: description || '',
    subscriberCount: subscriberCount || 0,
    videoCount: videoCount || 0,
    viewCount: viewCount || 0,
    joinedDate: joinedDate || null,
    country: country || null,
    uploadsPlaylistId,
    isActive: true,
  });

  // Immediately trigger initial sync
  try {
    await syncChannel(channel);
  } catch (err) {
    logger.warn(`Initial sync failed for newly added channel ${name}: ${err.message}`);
  }

  res.status(201).json({
    success: true,
    message: 'Channel added successfully and initial sync triggered.',
    data: channel,
  });
});

/**
 * @desc    Get active channels for public sidebar
 * @route   GET /api/channels
 * @access  Public
 */
exports.getChannels = asyncHandler(async (req, res) => {
  const channels = await Channel.findAll({
    where: { isActive: true, isShortsOnly: false },
    order: [['isPinned', 'DESC'], ['name', 'ASC']],
  });

  const formattedChannels = channels.map(ch => {
    const json = ch.toJSON();
    return {
      ...json,
      channelId: json.youtubeChannelId || json.youtube_channel_id || json.id,
      youtubeChannelId: json.youtubeChannelId || json.youtube_channel_id,
      subscriberCount: json.subscriberCount ?? json.subscriber_count ?? 0,
      subscriber_count: json.subscriberCount ?? json.subscriber_count ?? 0,
      videoCount: json.videoCount ?? json.video_count ?? 0,
      video_count: json.videoCount ?? json.video_count ?? 0,
      viewCount: json.viewCount ?? json.view_count ?? 0,
      view_count: json.viewCount ?? json.view_count ?? 0,
      bannerUrl: json.bannerUrl || json.banner_url || '',
      banner_url: json.bannerUrl || json.banner_url || '',
      logoUrl: json.logoUrl || json.logo_url || '',
      logo_url: json.logoUrl || json.logo_url || '',
      joinedDate: json.joinedDate || json.joined_date || null,
      joined_date: json.joinedDate || json.joined_date || null,
      description: json.description || '',
      handle: json.handle || '',
    };
  });

  if (formattedChannels.length > 0) {
    console.log("Sample Channel API Response:", formattedChannels[0]);
  }

  res.status(200).json({
    success: true,
    count: formattedChannels.length,
    data: formattedChannels,
  });
});

/**
 * @desc    Get all channels for admin management
 * @route   GET /api/channels/admin/all
 * @access  Admin
 */
exports.getAdminChannels = asyncHandler(async (req, res) => {
  const channels = await Channel.findAll({
    attributes: [
      'id',
      'youtubeChannelId',
      'handle',
      'name',
      'logoUrl',
      'bannerUrl',
      'description',
      'subscriberCount',
      'videoCount',
      'viewCount',
      'joinedDate',
      'country',
      'isActive',
      'lastSyncedAt',
      'lastSyncStatus',
      'lastSyncError',
      'checkLiveStatus',
      'isLiveNow',
      'upcomingPremiereAt',
      'upcomingVideoId',
      'scheduledStartTime',
      'discoveredAt',
      'isCurrentlyLive',
      'liveVideoId',
      'liveStartedAt',
      'lastLiveCheckAt',
      'lastNotifiedVideoId',
      'createdAt',
    ],
    order: [['createdAt', 'DESC']],
  });

  // Note: videoCount is now a direct field on the Channel model
  // No need to attach video counts dynamically here unless it's for ChannelVideo count specifically
  // const channelsWithCounts = await Promise.all(
  //   channels.map(async (ch) => {
  //     const videoCount = await ChannelVideo.count({ where: { channelId: ch.id } });
  //     return {
  //       ...ch.toJSON(),
  //       videoCount,
  //     };
  //   })
  // );

  res.status(200).json({
    success: true,
    count: channels.length,
    data: channels,
  });
});

/**
 * @desc    Get paginated videos for a channel
 * @route   GET /api/channels/:id/videos
 * @access  Public
 */
exports.getChannelVideos = asyncHandler(async (req, res) => {
  const channelId = req.params.id;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 12;
  const offset = (page - 1) * limit;

  const channel = await Channel.findByPk(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, message: 'Channel not found.' });
  }

  const { count, rows: videos } = await ChannelVideo.findAndCountAll({
    where: { channelId, isAvailable: true, isShort: false },
    attributes: ['id', 'youtubeVideoId', 'title', 'thumbnailUrl', 'publishedAt', 'isAvailable', 'liveBroadcastContent', 'scheduledStartTime'],
    order: [['publishedAt', 'DESC']],
    limit,
    offset,
  });

  if (channelId == 2) { // RCM World Channel
    const nextGurukulTime = getNextGurukulSchedule();
    const now = new Date();

    let actualLiveVideo = null;
    let actualUpcomingVideo = null;

    // Check if there's an actual live or upcoming video from YouTube
    for (const video of videos) {
      if (video.liveBroadcastContent === 'live') {
        actualLiveVideo = video;
        break;
      }
      if (video.liveBroadcastContent === 'upcoming' && video.scheduledStartTime) {
        const scheduled = new Date(video.scheduledStartTime);
        // Consider it an actual upcoming if within the next 24 hours of gurukul time
        if (scheduled.getTime() >= nextGurukulTime.getTime() - 24 * 60 * 60 * 1000 && scheduled.getTime() <= nextGurukulTime.getTime() + 60 * 60 * 1000) {
          actualUpcomingVideo = video;
          break;
        }
      }
    }

    let gurukulCard = null;

    // If no actual live video exists, check for upcoming or create synthetic
    if (!actualLiveVideo) {
      // Current time in IST
      const istOffset = 5.5 * 60 * 60 * 1000;
      const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
      const currentIstTime = new Date(utcTime + istOffset);
      
      // Gurukul ends at 7:30 AM IST (1:00 UTC on the same day)
      const gurukulEndTimeIST = new Date(Date.UTC(nextGurukulTime.getFullYear(), nextGurukulTime.getMonth(), nextGurukulTime.getDate(), 2, 0, 0)); // 2:00 UTC = 7:30 AM IST

      if (currentIstTime < gurukulEndTimeIST) { // Only show synthetic if before 7:30 AM IST of the gurukul day
        gurukulCard = {
          id: `gurukul-upcoming-${nextGurukulTime.toISOString().split('T')[0]}`,
          youtubeVideoId: '_Gurukul_Synthetic_Video_ID_', // Placeholder
          title: `RCM World Gurukul: Daily Session with TC Sir`,
          thumbnailUrl: 'https://yt3.ggpht.com/i8k5hB_C2h3_x2fN0R3-Z7-0-5-0-0-0-0/hqdefault.jpg', // Placeholder thumbnail
          publishedAt: nextGurukulTime,
          isAvailable: true,
          liveBroadcastContent: 'upcoming',
          scheduledStartTime: nextGurukulTime,
          isSynthetic: true, // Custom flag to identify synthetic card
        };
      }
    }

    let finalVideos = [...videos];
    // If there's an actual live video, it takes top priority
    if (actualLiveVideo) {
      finalVideos = finalVideos.filter(v => v.id !== actualLiveVideo.id);
      finalVideos.unshift(actualLiveVideo);
    } else if (actualUpcomingVideo) { // If no live, but actual upcoming exists, it takes priority
      finalVideos = finalVideos.filter(v => v.id !== actualUpcomingVideo.id);
      finalVideos.unshift(actualUpcomingVideo);
    } else if (gurukulCard) { // If neither, and synthetic card is generated, use it
      finalVideos.unshift(gurukulCard);
    }

    return res.status(200).json({
      success: true,
      currentPage: page,
      totalPages: Math.ceil((count + (gurukulCard ? 1 : 0)) / limit) || 1,
      totalVideos: count + (gurukulCard ? 1 : 0),
      count: finalVideos.length,
      channel: {
        id: channel.id,
        channelId: channel.youtubeChannelId || channel.youtube_channel_id,
        youtubeChannelId: channel.youtubeChannelId || channel.youtube_channel_id,
        name: channel.name,
        logoUrl: channel.logoUrl || channel.logo_url,
        logo_url: channel.logoUrl || channel.logo_url,
        bannerUrl: channel.bannerUrl || channel.banner_url,
        banner_url: channel.bannerUrl || channel.banner_url,
        description: channel.description,
        handle: channel.handle,
        subscriberCount: channel.subscriberCount ?? channel.subscriber_count ?? 0,
        subscriber_count: channel.subscriberCount ?? channel.subscriber_count ?? 0,
        videoCount: channel.videoCount ?? channel.video_count ?? 0,
        video_count: channel.videoCount ?? channel.video_count ?? 0,
        viewCount: channel.viewCount ?? channel.view_count ?? 0,
        view_count: channel.viewCount ?? channel.view_count ?? 0,
        joinedDate: channel.joinedDate || channel.joined_date,
        joined_date: channel.joinedDate || channel.joined_date,
        country: channel.country,
        isCurrentlyLive: channel.isCurrentlyLive,
        upcomingVideoId: channel.upcomingVideoId,
        scheduledStartTime: channel.scheduledStartTime,
        liveVideoId: channel.liveVideoId,
        liveStartedAt: channel.liveStartedAt,
        lastKnownLiveStartTime: channel.lastKnownLiveStartTime,
        isPinned: channel.isPinned,
      },
      data: finalVideos,
    });
  } else {
    return res.status(200).json({
      success: true,
      currentPage: page,
      totalPages: Math.ceil(count / limit) || 1,
      totalVideos: count,
      count: videos.length,
      channel: {
        id: channel.id,
        channelId: channel.youtubeChannelId || channel.youtube_channel_id,
        youtubeChannelId: channel.youtubeChannelId || channel.youtube_channel_id,
        name: channel.name,
        logoUrl: channel.logoUrl || channel.logo_url,
        logo_url: channel.logoUrl || channel.logo_url,
        bannerUrl: channel.bannerUrl || channel.banner_url,
        banner_url: channel.bannerUrl || channel.banner_url,
        description: channel.description,
        handle: channel.handle,
        subscriberCount: channel.subscriberCount ?? channel.subscriber_count ?? 0,
        subscriber_count: channel.subscriberCount ?? channel.subscriber_count ?? 0,
        videoCount: channel.videoCount ?? channel.video_count ?? 0,
        video_count: channel.videoCount ?? channel.video_count ?? 0,
        viewCount: channel.viewCount ?? channel.view_count ?? 0,
        view_count: channel.viewCount ?? channel.view_count ?? 0,
        joinedDate: channel.joinedDate || channel.joined_date,
        joined_date: channel.joinedDate || channel.joined_date,
        country: channel.country,
        // These fields are primarily for displaying the channel's overall live status, not individual videos
        // Individual video cards will now use their own liveBroadcastContent and scheduledStartTime
        isCurrentlyLive: channel.isCurrentlyLive,
        upcomingVideoId: channel.upcomingVideoId,
        scheduledStartTime: channel.scheduledStartTime,
        liveVideoId: channel.liveVideoId,
        liveStartedAt: channel.liveStartedAt,
        lastKnownLiveStartTime: channel.lastKnownLiveStartTime,
        isPinned: channel.isPinned,
      },
      data: videos,
    });
  }
});

/**
 * @desc    Toggle channel active status (pause/resume sync)
 * @route   PATCH /api/channels/:id/toggle
 * @access  Admin
 */
exports.toggleChannelActive = asyncHandler(async (req, res) => {
  const channelId = req.params.id;
  const channel = await Channel.findByPk(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, message: 'Channel not found.' });
  }

  channel.isActive = !channel.isActive;
  await channel.save();

  res.status(200).json({
    success: true,
    message: `Channel ${channel.name} is now ${channel.isActive ? 'Active' : 'Paused'}.`,
    data: channel,
  });
});

/**
 * @desc    Trigger manual sync for a channel on-demand
 * @route   POST /api/channels/:id/sync
 * @access  Admin
 */
exports.syncChannelOnDemand = asyncHandler(async (req, res) => {
  const channelId = req.params.id;
  const channel = await Channel.findByPk(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, message: 'Channel not found.' });
  }

  try {
    const newCount = await syncChannel(channel);
    res.status(200).json({
      success: true,
      message: `Channel synced successfully. ${newCount} new videos added.`,
      newVideosCount: newCount,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: `Failed to sync channel: ${err.message}`,
    });
  }
});

/**
 * @desc    Delete channel and its videos
 * @route   DELETE /api/channels/:id
 * @access  Admin
 */
exports.deleteChannel = asyncHandler(async (req, res) => {
  const channelId = req.params.id;
  const channel = await Channel.findByPk(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, message: 'Channel not found.' });
  }

  // Delete associated videos first (or cascade delete handles it)
  await ChannelVideo.destroy({ where: { channelId } });
  await channel.destroy();

  res.status(200).json({
    success: true,
    message: 'Channel and its videos deleted successfully.',
  });
});

/**
 * @desc    Toggle channel live check status (Priority 4)
 * @route   PATCH /api/channels/:id/toggle-live
 * @access  Admin
 */
exports.toggleLiveStatus = asyncHandler(async (req, res) => {
  const channelId = req.params.id;
  const channel = await Channel.findByPk(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, message: 'Channel not found.' });
  }

  channel.checkLiveStatus = !channel.checkLiveStatus;
  await channel.save();

  res.status(200).json({
    success: true,
    message: `Live checking for channel ${channel.name} is now ${channel.checkLiveStatus ? 'Enabled' : 'Disabled'}.`,
    data: channel,
  });
});
