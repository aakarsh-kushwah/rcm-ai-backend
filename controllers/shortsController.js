const asyncHandler = require('express-async-handler');
const { Channel, ChannelVideo, ShortInteraction, ShortComment, User } = require('../models');
const { Op } = require('sequelize');

/**
 * @desc    Get feed of Shorts videos
 * @route   GET /api/shorts
 * @access  Public / User
 */
exports.getShorts = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const offset = (page - 1) * limit;
  const { channelId } = req.query;

  const whereClause = { isShort: true, isAvailable: true };
  if (channelId) {
    whereClause.channelId = channelId;
  }

  const { count, rows: shorts } = await ChannelVideo.findAndCountAll({
    where: whereClause,
    include: [
      {
        model: Channel,
        as: 'channel',
        attributes: ['id', 'name', 'handle', 'logoUrl', 'youtubeChannelId'],
      },
    ],
    order: [['publishedAt', 'DESC']],
    limit,
    offset,
  });

  // If user is authenticated, check which shorts the user liked
  let userLikes = new Set();
  if (req.user && req.user.id) {
    const videoIds = shorts.map(s => s.id);
    if (videoIds.length > 0) {
      const interactions = await ShortInteraction.findAll({
        where: {
          userId: req.user.id,
          channelVideoId: { [Op.in]: videoIds },
          type: 'like',
        },
        attributes: ['channelVideoId'],
      });
      interactions.forEach(i => userLikes.add(i.channelVideoId));
    }
  }

  const formattedShorts = shorts.map(s => {
    const json = s.toJSON();
    return {
      ...json,
      isLiked: userLikes.has(json.id),
      videoUrl: `https://www.youtube.com/watch?v=${json.youtubeVideoId}`,
    };
  });

  res.status(200).json({
    success: true,
    currentPage: page,
    totalPages: Math.ceil(count / limit) || 1,
    totalItems: count,
    count: formattedShorts.length,
    data: formattedShorts,
  });
});

/**
 * @desc    Toggle like on a Short video
 * @route   POST /api/shorts/:id/like
 * @access  User / Admin
 */
exports.toggleLikeShort = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  const userId = req.user.id;

  const video = await ChannelVideo.findByPk(videoId);
  if (!video || !video.isShort) {
    return res.status(404).json({ success: false, message: 'Short video not found.' });
  }

  const existing = await ShortInteraction.findOne({
    where: { userId, channelVideoId: videoId, type: 'like' },
  });

  let isLiked = false;
  if (existing) {
    await existing.destroy();
    video.likesCount = Math.max(0, (video.likesCount || 0) - 1);
    isLiked = false;
  } else {
    await ShortInteraction.create({
      userId,
      channelVideoId: videoId,
      type: 'like',
    });
    video.likesCount = (video.likesCount || 0) + 1;
    isLiked = true;
  }

  await video.save();

  res.status(200).json({
    success: true,
    isLiked,
    likesCount: video.likesCount,
    message: isLiked ? 'Short liked successfully.' : 'Short unliked successfully.',
  });
});

/**
 * @desc    Add a comment on a Short video
 * @route   POST /api/shorts/:id/comments
 * @access  User / Admin
 */
exports.addShortComment = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  const userId = req.user.id;
  const { comment } = req.body;

  if (!comment || !comment.trim()) {
    return res.status(400).json({ success: false, message: 'Comment text is required.' });
  }

  const video = await ChannelVideo.findByPk(videoId);
  if (!video || !video.isShort) {
    return res.status(404).json({ success: false, message: 'Short video not found.' });
  }

  const newComment = await ShortComment.create({
    userId,
    channelVideoId: videoId,
    comment: comment.trim(),
  });

  video.commentsCount = (video.commentsCount || 0) + 1;
  await video.save();

  // Fetch created comment with user details
  const createdWithUser = await ShortComment.findByPk(newComment.id, {
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'fullName', 'avatar'],
      },
    ],
  });

  res.status(201).json({
    success: true,
    message: 'Comment added successfully.',
    data: createdWithUser,
    commentsCount: video.commentsCount,
  });
});

/**
 * @desc    Get comments for a Short video
 * @route   GET /api/shorts/:id/comments
 * @access  Public
 */
exports.getShortComments = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;

  const video = await ChannelVideo.findByPk(videoId);
  if (!video || !video.isShort) {
    return res.status(404).json({ success: false, message: 'Short video not found.' });
  }

  const { count, rows: comments } = await ShortComment.findAndCountAll({
    where: { channelVideoId: videoId },
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'fullName', 'avatar'],
      },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  res.status(200).json({
    success: true,
    currentPage: page,
    totalPages: Math.ceil(count / limit) || 1,
    totalItems: count,
    data: comments,
  });
});

/**
 * @desc    Admin: Get all Shorts with isolation/filtering
 * @route   GET /api/admin/shorts
 * @access  Admin
 */
exports.adminGetShorts = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;
  const { channelId, search } = req.query;

  const whereClause = { isShort: true };
  if (channelId) {
    whereClause.channelId = channelId;
  }
  if (search) {
    whereClause.title = { [Op.like]: `%${search}%` };
  }

  const { count, rows: shorts } = await ChannelVideo.findAndCountAll({
    where: whereClause,
    include: [
      {
        model: Channel,
        as: 'channel',
        attributes: ['id', 'name', 'handle', 'logoUrl', 'isShortsOnly'],
      },
    ],
    order: [['publishedAt', 'DESC']],
    limit,
    offset,
  });

  res.status(200).json({
    success: true,
    currentPage: page,
    totalPages: Math.ceil(count / limit) || 1,
    totalItems: count,
    data: shorts,
  });
});

/**
 * @desc    Admin: Toggle channel isShortsOnly setting
 * @route   PATCH /api/channels/:id/toggle-shorts-only
 * @access  Admin
 */
exports.adminToggleChannelShortsOnly = asyncHandler(async (req, res) => {
  const channelId = req.params.id;
  const channel = await Channel.findByPk(channelId);
  if (!channel) {
    return res.status(404).json({ success: false, message: 'Channel not found.' });
  }

  channel.isShortsOnly = !channel.isShortsOnly;
  await channel.save();

  res.status(200).json({
    success: true,
    message: `Channel ${channel.name} is now ${channel.isShortsOnly ? 'Shorts Only' : 'Standard'}.`,
    data: channel,
  });
});

/**
 * @desc    Admin: Toggle video isShort status
 * @route   PATCH /api/admin/videos/:id/toggle-short
 * @access  Admin
 */
exports.adminToggleVideoShort = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  const video = await ChannelVideo.findByPk(videoId);
  if (!video) {
    return res.status(404).json({ success: false, message: 'Video not found.' });
  }

  video.isShort = !video.isShort;
  await video.save();

  // Recalculate shorts_count for channel
  const shortsCount = await ChannelVideo.count({ where: { channelId: video.channelId, isShort: true } });
  await Channel.update({ shortsCount }, { where: { id: video.channelId } });

  res.status(200).json({
    success: true,
    message: `Video "${video.title}" is now marked as ${video.isShort ? 'Short' : 'Standard'}.`,
    data: video,
  });
});

/**
 * @desc    Admin: Delete a Short video
 * @route   DELETE /api/admin/shorts/:id
 * @access  Admin
 */
exports.adminDeleteShort = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  const video = await ChannelVideo.findByPk(videoId);
  if (!video) {
    return res.status(404).json({ success: false, message: 'Video not found.' });
  }

  const channelId = video.channelId;
  await video.destroy();

  // Recalculate shorts_count
  const shortsCount = await ChannelVideo.count({ where: { channelId, isShort: true } });
  await Channel.update({ shortsCount }, { where: { id: channelId } });

  res.status(200).json({
    success: true,
    message: 'Short video deleted successfully.',
  });
});
