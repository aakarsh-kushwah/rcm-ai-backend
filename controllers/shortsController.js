/**
 * shortsController.js  (production-hardened)
 *
 * Design goals
 *  - Public feed endpoints are read-heavy: cached (TTL) + in-flight request coalescing,
 *    so 10k concurrent users hitting the same page = 1 DB query, not 10k.
 *  - No COUNT(*) on every scroll: counts are cached separately.
 *  - Cursor (keyset) pagination: constant speed however deep the user scrolls.
 *  - Likes/comments use atomic counter updates (no read-modify-write races).
 *  - Import endpoint: safe URL parsing, per-channel lock, no junk channels, no email flood.
 *  - Logging via console only inside this file (no pino dependency).
 *
 * NOTE: the cache is per-process. With PM2 cluster / multiple instances every instance keeps
 * its own copy (max staleness = TTL). For a shared cache swap `cache` for Redis later.
 */

const asyncHandler = require('express-async-handler');
const axios = require('axios');
const { Op } = require('sequelize');
const { parse } = require('iso8601-duration');
const { Channel, ChannelVideo, ShortInteraction, ShortComment, User } = require('../models');
const { syncChannel } = require('../services/channelSyncService');

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const FEED_TTL_MS = 15 * 1000;        // feed page cache
const COUNT_TTL_MS = 60 * 1000;       // total count cache
const CHANNEL_TTL_MS = 5 * 60 * 1000; // channel lookup cache
const COMMENTS_TTL_MS = 5 * 1000;
const CACHE_MAX_ENTRIES = 2000;

const FEED_DEFAULT_LIMIT = 10;
const FEED_MAX_LIMIT = 30;
const COMMENT_MAX_LENGTH = 500;
const MAX_SHORT_SECONDS = 180;
const IMPORT_MAX_PAGES = 6; // 6 x 50 = up to 300 shorts per channel import request

const CHANNEL_ATTRS = ['id', 'name', 'handle', 'logoUrl', 'youtubeChannelId'];

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

/* ------------------------------------------------------------------ */
/* Tiny TTL cache + in-flight coalescing                               */
/* ------------------------------------------------------------------ */
const store = new Map(); // key -> { v, exp }
const inflight = new Map(); // key -> Promise

const STALE_FACTOR = 4; // entry may be served stale for ttl * STALE_FACTOR while refreshing in background

const cache = {
  /** returns the raw entry { v, exp, stale } or undefined (expired beyond stale window) */
  getEntry(key) {
    const e = store.get(key);
    if (!e) return undefined;
    if (e.stale < Date.now()) {
      store.delete(key);
      return undefined;
    }
    return e;
  },
  set(key, v, ttl) {
    if (store.size >= CACHE_MAX_ENTRIES && !store.has(key)) {
      // evict oldest entry (Map keeps insertion order)
      store.delete(store.keys().next().value);
    }
    const now = Date.now();
    store.set(key, { v, exp: now + ttl, stale: now + ttl * STALE_FACTOR });
  },
  clear() {
    store.clear();
  },
};

/** Return cached value or run loader once even if many requests ask at the same time. */
function refresh(key, ttl, loader) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await loader();
      cache.set(key, v, ttl);
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function cached(key, ttl, loader) {
  const e = cache.getEntry(key);
  if (e && e.exp > Date.now()) return e.v; // fresh
  if (e) {
    // stale: answer instantly, refresh in background (nobody waits on the DB)
    refresh(key, ttl, loader).catch((err) => log.error(`[CACHE] refresh failed for ${key}: ${err.message}`));
    return e.v;
  }
  return refresh(key, ttl, loader); // cold: all concurrent callers share ONE loader run
}

/** Call after any admin change that affects what the public feed shows. */
function invalidateFeedCache() {
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function encodeCursor(row) {
  const d = new Date(row.publishedAt).toISOString();
  return Buffer.from(`${d}|${row.id}`).toString('base64url');
}

function decodeCursor(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  try {
    const [iso, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    const id = rest.join('|');
    const date = new Date(iso);
    if (!id || Number.isNaN(date.getTime())) return null;
    return { date, id };
  } catch (_) {
    return null;
  }
}

async function refreshShortsCount(channelId) {
  const shortsCount = await ChannelVideo.count({ where: { channelId, isShort: true } });
  await Channel.update({ shortsCount }, { where: { id: channelId } });
  return shortsCount;
}

/** Attach isLiked with ONE indexed query for the whole page. */
async function attachLikes(rows, userId) {
  const liked = new Set();
  if (userId && rows.length > 0) {
    const interactions = await ShortInteraction.findAll({
      where: {
        userId,
        channelVideoId: { [Op.in]: rows.map((r) => r.id) },
        type: 'like',
      },
      attributes: ['channelVideoId'],
      raw: true,
    });
    interactions.forEach((i) => liked.add(i.channelVideoId));
  }
  return rows.map((r) => ({
    ...r,
    isLiked: liked.has(r.id),
    videoUrl: `https://www.youtube.com/watch?v=${r.youtubeVideoId}`,
  }));
}

/* ------------------------------------------------------------------ */
/* Public feed (shared by getShorts and getShortsByChannel)            */
/* ------------------------------------------------------------------ */
async function countFeed(channelId) {
  return cached(`feedcount:${channelId || 'all'}`, COUNT_TTL_MS, () => {
    const where = { isShort: true, isAvailable: true };
    if (channelId) where.channelId = channelId;
    return ChannelVideo.count({ where });
  });
}

async function loadFeedPage({ channelId, cursor, offset, limit }) {
  const where = { isShort: true, isAvailable: true };
  if (channelId) where.channelId = channelId;
  if (cursor) {
    where[Op.or] = [
      { publishedAt: { [Op.lt]: cursor.date } },
      { publishedAt: cursor.date, id: { [Op.lt]: cursor.id } },
    ];
  }

  const rows = await ChannelVideo.findAll({
    where,
    attributes: { exclude: ['description'] }, // smaller payload for feed
    include: [{ model: Channel, as: 'channel', attributes: CHANNEL_ATTRS, required: false }],
    order: [
      ['publishedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: limit + 1, // +1 to know if there is a next page without COUNT
    offset: cursor ? 0 : offset,
    raw: true,
    nest: true,
  });

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    hasMore,
    nextCursor: hasMore ? encodeCursor(data[data.length - 1]) : null,
  };
}

async function serveFeed(req, res, channelId) {
  const limit = clampInt(req.query.limit, FEED_DEFAULT_LIMIT, 1, FEED_MAX_LIMIT);
  const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const cursor = decodeCursor(cursorRaw);
  const page = clampInt(req.query.page, 1, 1, 10000);
  const offset = (page - 1) * limit;

  const cacheKey = `feed:${channelId || 'all'}:${cursor ? `c${cursorRaw}` : `p${page}`}:${limit}`;
  const [pageData, totalItems] = await Promise.all([
    cached(cacheKey, FEED_TTL_MS, () => loadFeedPage({ channelId, cursor, offset, limit })),
    countFeed(channelId),
  ]);
  const data = await attachLikes(pageData.data, req.user && req.user.id);

  // Anonymous responses are identical for everyone -> let nginx / CDN absorb the traffic.
  // Logged-in responses contain isLiked -> private.
  if (req.headers.authorization) {
    res.set('Cache-Control', 'private, max-age=5');
  } else {
    res.set('Cache-Control', 'public, max-age=5, s-maxage=15, stale-while-revalidate=30');
  }
  res.set('Vary', 'Authorization');

  res.status(200).json({
    success: true,
    currentPage: page,
    totalPages: Math.ceil(totalItems / limit) || 1,
    totalItems,
    count: data.length,
    hasMore: pageData.hasMore,
    nextCursor: pageData.nextCursor,
    data,
  });
}

/**
 * @desc    Get feed of Shorts videos
 * @route   GET /api/shorts?limit=10&cursor=<nextCursor>   (or ?page=N)
 * @access  Public / User
 */
exports.getShorts = asyncHandler(async (req, res) => {
  await serveFeed(req, res, req.query.channelId || null);
});

/**
 * @desc    Get Shorts videos for a specific channel
 * @route   GET /api/shorts/channel/:channelId
 * @access  Public / User
 */
exports.getShortsByChannel = asyncHandler(async (req, res) => {
  const channelParam = String(req.params.channelId || '').slice(0, 64);
  const channel = await cached(`channel:${channelParam}`, CHANNEL_TTL_MS, async () => {
    const parsedId = parseInt(channelParam, 10);
    const row = await Channel.findOne({
      where: {
        [Op.or]: [...(Number.isNaN(parsedId) ? [] : [{ id: parsedId }]), { youtubeChannelId: channelParam }],
      },
      attributes: ['id'],
      raw: true,
    });
    return row || false; // cache negative result too (avoids DB hammering on bad ids)
  });

  if (!channel) {
    return res.status(404).json({ success: false, message: 'Channel not found.' });
  }
  await serveFeed(req, res, channel.id);
});

/* ------------------------------------------------------------------ */
/* Likes / comments                                                    */
/* ------------------------------------------------------------------ */

/**
 * @desc    Toggle like on a Short video (atomic, race-safe)
 * @route   POST /api/shorts/:id/like
 * @access  User / Admin
 *
 * Requires UNIQUE index on ShortInteraction (userId, channelVideoId, type).
 */
exports.toggleLikeShort = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  const userId = req.user.id;

  const video = await ChannelVideo.findByPk(videoId, { attributes: ['id', 'isShort'], raw: true });
  if (!video || !video.isShort) {
    return res.status(404).json({ success: false, message: 'Short video not found.' });
  }

  let isLiked;
  const removed = await ShortInteraction.destroy({
    where: { userId, channelVideoId: videoId, type: 'like' },
  });

  if (removed > 0) {
    await ChannelVideo.increment('likesCount', { by: -removed, where: { id: videoId } });
    isLiked = false;
  } else {
    try {
      await ShortInteraction.create({ userId, channelVideoId: videoId, type: 'like' });
      await ChannelVideo.increment('likesCount', { by: 1, where: { id: videoId } });
    } catch (err) {
      // Double-tap / parallel request: row already exists -> treat as liked, don't double count
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    }
    isLiked = true;
  }

  const fresh = await ChannelVideo.findByPk(videoId, { attributes: ['likesCount'], raw: true });
  const likesCount = Math.max(0, (fresh && fresh.likesCount) || 0);

  res.status(200).json({
    success: true,
    isLiked,
    likesCount,
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
  const text = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';

  if (!text) {
    return res.status(400).json({ success: false, message: 'Comment text is required.' });
  }
  if (text.length > COMMENT_MAX_LENGTH) {
    return res
      .status(400)
      .json({ success: false, message: `Comment must be at most ${COMMENT_MAX_LENGTH} characters.` });
  }

  const video = await ChannelVideo.findByPk(videoId, { attributes: ['id', 'isShort'], raw: true });
  if (!video || !video.isShort) {
    return res.status(404).json({ success: false, message: 'Short video not found.' });
  }

  const newComment = await ShortComment.create({ userId, channelVideoId: videoId, comment: text });
  await ChannelVideo.increment('commentsCount', { by: 1, where: { id: videoId } });

  const [createdWithUser, fresh] = await Promise.all([
    ShortComment.findByPk(newComment.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'fullName', 'avatar'] }],
    }),
    ChannelVideo.findByPk(videoId, { attributes: ['commentsCount'], raw: true }),
  ]);

  res.status(201).json({
    success: true,
    message: 'Comment added successfully.',
    data: createdWithUser,
    commentsCount: (fresh && fresh.commentsCount) || 0,
  });
});

/**
 * @desc    Get comments for a Short video
 * @route   GET /api/shorts/:id/comments
 * @access  Public
 */
exports.getShortComments = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  const page = clampInt(req.query.page, 1, 1, 10000);
  const limit = clampInt(req.query.limit, 20, 1, 50);
  const offset = (page - 1) * limit;

  const result = await cached(`comments:${videoId}:${page}:${limit}`, COMMENTS_TTL_MS, async () => {
    const video = await ChannelVideo.findByPk(videoId, { attributes: ['id', 'isShort'], raw: true });
    if (!video || !video.isShort) return null;

    const { count, rows } = await ShortComment.findAndCountAll({
      where: { channelVideoId: videoId },
      include: [{ model: User, as: 'user', attributes: ['id', 'fullName', 'avatar'] }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    return { count, rows: rows.map((r) => r.toJSON()) };
  });

  if (!result) {
    return res.status(404).json({ success: false, message: 'Short video not found.' });
  }

  res.status(200).json({
    success: true,
    currentPage: page,
    totalPages: Math.ceil(result.count / limit) || 1,
    totalItems: result.count,
    data: result.rows,
  });
});

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

/**
 * @desc    Admin: Get all Shorts with filtering
 * @route   GET /api/admin/shorts
 * @access  Admin
 */
exports.adminGetShorts = asyncHandler(async (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 100000);
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const offset = (page - 1) * limit;
  const { channelId, search } = req.query;

  const whereClause = { isShort: true };
  if (channelId) whereClause.channelId = channelId;
  if (search && typeof search === 'string') {
    const safe = search.slice(0, 100).replace(/[%_\\]/g, '\\$&');
    whereClause.title = { [Op.like]: `%${safe}%` };
  }

  const { count, rows } = await ChannelVideo.findAndCountAll({
    where: whereClause,
    include: [
      { model: Channel, as: 'channel', attributes: ['id', 'name', 'handle', 'logoUrl', 'isShortsOnly'] },
    ],
    order: [
      ['publishedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit,
    offset,
  });

  res.status(200).json({
    success: true,
    currentPage: page,
    totalPages: Math.ceil(count / limit) || 1,
    totalItems: count,
    data: rows,
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

  if (channel.isShortsOnly) {
    await ChannelVideo.update({ isShort: true }, { where: { channelId } });
  }
  await refreshShortsCount(channelId);
  invalidateFeedCache();

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
  const video = await ChannelVideo.findByPk(req.params.id);
  if (!video) {
    return res.status(404).json({ success: false, message: 'Video not found.' });
  }

  video.isShort = !video.isShort;
  await video.save();
  await refreshShortsCount(video.channelId);
  invalidateFeedCache();

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
  const video = await ChannelVideo.findByPk(req.params.id);
  if (!video) {
    return res.status(404).json({ success: false, message: 'Video not found.' });
  }

  const channelId = video.channelId;
  await video.destroy();
  await refreshShortsCount(channelId);
  invalidateFeedCache();

  res.status(200).json({ success: true, message: 'Short video deleted successfully.' });
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * Classify user input. Returns:
 *   { type: 'video',   value: '<11 char id>' }
 *   { type: 'channel', value: '<UC id | handle | legacy name>', kind: 'id'|'handle'|'legacy', shortsOnly }
 *   { type: 'unknown' }
 */
function detectYouTubeInput(input) {
  const unknown = { type: 'unknown', value: null };
  if (typeof input !== 'string') return unknown;
  const s = input.trim();
  if (!s || s.length > 300) return unknown;

  if (/^UC[\w-]{22}$/.test(s)) return { type: 'channel', value: s, kind: 'id', shortsOnly: false };
  if (/^@[\w.-]{1,100}$/.test(s)) return { type: 'channel', value: s.slice(1), kind: 'handle', shortsOnly: false };
  if (/^[\w-]{11}$/.test(s)) return { type: 'video', value: s };

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch (_) {
    return unknown;
  }

  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  const path = u.pathname;
  let m;

  if (host === 'youtu.be') {
    m = path.match(/^\/([\w-]{11})/);
    return m ? { type: 'video', value: m[1] } : unknown;
  }
  if (host !== 'youtube.com') return unknown;

  // channel forms first
  if ((m = path.match(/^\/shorts\/channel\/(UC[\w-]{22})/))) {
    return { type: 'channel', value: m[1], kind: 'id', shortsOnly: true };
  }
  if ((m = path.match(/^\/channel\/(UC[\w-]{22})/))) {
    return { type: 'channel', value: m[1], kind: 'id', shortsOnly: false };
  }
  if ((m = path.match(/^\/@([\w.-]+)/))) {
    return { type: 'channel', value: m[1], kind: 'handle', shortsOnly: /\/shorts\/?$/.test(path) };
  }
  if ((m = path.match(/^\/(?:c|user)\/([\w.-]+)/))) {
    return { type: 'channel', value: m[1], kind: 'legacy', shortsOnly: false };
  }

  // video forms
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return { type: 'video', value: v };
  if ((m = path.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/))) return { type: 'video', value: m[1] };

  return unknown;
}

function getApiKey() {
  return process.env.YOUTUBE_API_KEY;
}

async function ytGet(resource, params) {
  const { data } = await axios.get(`https://www.googleapis.com/youtube/v3/${resource}`, {
    params: { ...params, key: getApiKey() },
    timeout: 10000,
  });
  return data;
}

/** Fetch channel resource from YouTube (1 quota unit per call). Never uses search.list (100 units). */
async function fetchChannelFromYouTube(detected) {
  const part = 'snippet,statistics,contentDetails';
  let data;
  if (detected.kind === 'id') {
    data = await ytGet('channels', { part, id: detected.value });
  } else if (detected.kind === 'handle') {
    data = await ytGet('channels', { part, forHandle: `@${detected.value}` });
  } else {
    data = await ytGet('channels', { part, forUsername: detected.value });
    if (!(data.items || []).length) {
      data = await ytGet('channels', { part, forHandle: `@${detected.value}` });
    }
  }
  return (data.items || [])[0] || null;
}

function channelPayloadFromYouTube(chData, { shortsOnly = false } = {}) {
  const sn = chData.snippet || {};
  const st = chData.statistics || {};
  const cd = chData.contentDetails || {};
  return {
    youtubeChannelId: chData.id,
    name: sn.title || 'Unknown Channel',
    handle: sn.customUrl || null,
    logoUrl: (sn.thumbnails && ((sn.thumbnails.high && sn.thumbnails.high.url) || (sn.thumbnails.medium && sn.thumbnails.medium.url))) || null,
    description: sn.description || null,
    subscriberCount: st.subscriberCount ? parseInt(st.subscriberCount, 10) : 0,
    videoCount: st.videoCount ? parseInt(st.videoCount, 10) : 0,
    viewCount: st.viewCount ? parseInt(st.viewCount, 10) : 0,
    uploadsPlaylistId: (cd.relatedPlaylists && cd.relatedPlaylists.uploads) || null,
    isActive: true,
    source: shortsOnly ? 'shorts-only' : 'channel',
    isShortsOnly: shortsOnly,
  };
}

/** Find channel in DB by YouTube channel id; otherwise create it from API data. */
async function findOrCreateChannelFromYouTubeData(chData, opts) {
  const existing = await Channel.findOne({ where: { youtubeChannelId: chData.id } });
  if (existing) return existing;
  try {
    return await Channel.create(channelPayloadFromYouTube(chData, opts));
  } catch (err) {
    // parallel request created it first
    if (err.name === 'SequelizeUniqueConstraintError') {
      const again = await Channel.findOne({ where: { youtubeChannelId: chData.id } });
      if (again) return again;
    }
    throw err;
  }
}

function findChannelInDb(detected) {
  if (detected.kind === 'id') return Channel.findOne({ where: { youtubeChannelId: detected.value } });
  return Channel.findOne({
    where: {
      [Op.or]: [
        { handle: `@${detected.value}` },
        { handle: detected.value },
        { name: detected.value },
      ],
    },
  });
}

const importLocks = new Set(); // prevents double-click / parallel imports of the same channel

async function importChannel(detected, res) {
  const lockKey = `${detected.kind}:${String(detected.value).toLowerCase()}`;
  if (importLocks.has(lockKey)) {
    return res
      .status(409)
      .json({ success: false, message: 'This channel is already being imported. Please wait.' });
  }
  importLocks.add(lockKey);

  try {
    let channel = await findChannelInDb(detected);

    if (!channel) {
      log.info(`[IMPORT] Channel not in DB, fetching from YouTube: ${detected.value}`);
      const chData = await fetchChannelFromYouTube(detected);
      if (!chData) {
        return res.status(404).json({ success: false, message: 'Channel YouTube par nahi mila.' });
      }
      channel = await findOrCreateChannelFromYouTubeData(chData, { shortsOnly: detected.shortsOnly });
    }

    log.info(`[IMPORT] Syncing channel ${channel.name} (id=${channel.id})`);
    // skipAlerts: no email storm on bulk import; maxPages: bounded request time
    const newShortsCount = await syncChannel(channel, { skipAlerts: true, maxPages: IMPORT_MAX_PAGES });
    const shortsCount = await refreshShortsCount(channel.id);
    invalidateFeedCache();

    return res.status(200).json({
      success: true,
      message: `Channel "${channel.name}" synced. Added ${newShortsCount} new videos.`,
      data: { channelId: channel.id, name: channel.name, newShortsCount, shortsCount },
    });
  } finally {
    importLocks.delete(lockKey);
  }
}

async function importVideo(videoId, force, res) {
  const videoRes = await ytGet('videos', { part: 'snippet,contentDetails,statistics', id: videoId });
  const ytVideo = (videoRes.items || [])[0];
  if (!ytVideo) {
    return res.status(404).json({ success: false, message: 'YouTube video not found on YouTube.' });
  }

  const snippet = ytVideo.snippet || {};
  const contentDetails = ytVideo.contentDetails || {};
  const statistics = ytVideo.statistics || {};

  let totalSeconds = 0;
  try {
    const d = parse(contentDetails.duration);
    totalSeconds =
      (d.days || 0) * 86400 + (d.hours || 0) * 3600 + (d.minutes || 0) * 60 + (d.seconds || 0);
  } catch (e) {
    log.warn(`[IMPORT] Could not parse duration for ${videoId}: ${e.message}`);
  }

  if (!force && totalSeconds > MAX_SHORT_SECONDS) {
    return res.status(400).json({
      success: false,
      message: `Ye Short nahi lag raha (duration ${totalSeconds}s > ${MAX_SHORT_SECONDS}s). Phir bhi import karna ho to force=true bhejo.`,
    });
  }

  // Resolve (or create) the owning channel
  let channel = await Channel.findOne({ where: { youtubeChannelId: snippet.channelId } });
  if (!channel) {
    const chData = await fetchChannelFromYouTube({ kind: 'id', value: snippet.channelId });
    if (!chData) {
      return res.status(502).json({ success: false, message: 'Video ka channel YouTube se fetch nahi ho paya.' });
    }
    channel = await findOrCreateChannelFromYouTubeData(chData, { shortsOnly: false });
  }

  const fields = {
    channelId: channel.id,
    title: snippet.title || 'Untitled Short',
    description: snippet.description || '',
    thumbnailUrl:
      (snippet.thumbnails &&
        ((snippet.thumbnails.high && snippet.thumbnails.high.url) ||
          (snippet.thumbnails.medium && snippet.thumbnails.medium.url) ||
          (snippet.thumbnails.default && snippet.thumbnails.default.url))) ||
      '',
    durationStr: contentDetails.duration || '',
    totalSeconds,
    viewCount: statistics.viewCount ? parseInt(statistics.viewCount, 10) : 0,
    publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : new Date(),
    isAvailable: true,
    isShort: true,
  };

  // likesCount / commentsCount are OUR in-app counters -> never overwritten by YouTube stats
  const [dbVideo, created] = await ChannelVideo.findOrCreate({
    where: { youtubeVideoId: videoId },
    defaults: { ...fields, youtubeVideoId: videoId },
  });
  if (!created) await dbVideo.update(fields);

  await refreshShortsCount(channel.id);
  invalidateFeedCache();
  log.info(`[IMPORT] ${created ? 'Created' : 'Updated'} short ${videoId} (${fields.title})`);

  return res.status(200).json({
    success: true,
    message: `Short "${dbVideo.title}" imported successfully.`,
    data: dbVideo,
  });
}

/**
 * @desc    Admin: Import single YouTube Short (video URL/ID) OR all shorts of a channel (channel URL/@handle/UC id)
 * @route   POST /api/admin/shorts/import-single
 * @access  Admin
 */
exports.adminImportSingleShort = asyncHandler(async (req, res) => {
  try {
    const rawInput = (req.body && (req.body.videoUrl || req.body.url || req.body.shortUrl)) || '';
    if (!rawInput) {
      return res.status(400).json({ success: false, message: 'YouTube URL or ID is required.' });
    }
    if (!getApiKey()) {
      log.error('[IMPORT] YOUTUBE_API_KEY is not configured.');
      return res.status(500).json({ success: false, message: 'YouTube API key not configured on backend.' });
    }

    const detected = detectYouTubeInput(rawInput);

    if (detected.type === 'channel') return await importChannel(detected, res);
    if (detected.type === 'video') return await importVideo(detected.value, req.body.force === true, res);

    return res.status(400).json({
      success: false,
      message: 'Invalid YouTube URL or ID. Please provide a valid channel or video link.',
    });
  } catch (err) {
    log.error(`[IMPORT] Failed: ${err.message}`);
    const upstream = err.response && err.response.status;
    const status = upstream === 403 || upstream === 429 ? 503 : 500; // YouTube quota / rate limit
    return res.status(status).json({
      success: false,
      message: status === 503 ? 'YouTube API quota/limit issue. Thodi der baad try karo.' : err.message || 'Import failed',
      error: err.message,
    });
  }
});