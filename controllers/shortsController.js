/**
 * shortsController.js  (Production-Hardened, Strict Short/Long Separation)
 *
 * Guarantees:
 *  - A video is a "Short" ONLY IF isShort = true AND 0 < totalSeconds <= 180.
 *    Every public read (feed, count, comments, likes) and every counter
 *    (channel.shortsCount) applies this rule, so long-form never leaks.
 *  - Global feed uses creator interleaving (round-robin + adjacency guard).
 *  - TTL cache with stale-while-revalidate, in-flight coalescing and
 *    generation-safe invalidation.
 *  - Atomic like/comment counters inside transactions.
 *  - Import endpoint tolerates many payload shapes and never crashes on bad input.
 *  - Never-repeat feed (Redis seen-history + batch flush): getFeed / trackView (see bottom section).
 */

const asyncHandler = require('express-async-handler');
const axios = require('axios');
const cheerio = require('cheerio');
const { Op, DataTypes, QueryTypes, literal } = require('sequelize');
const { parse } = require('iso8601-duration');
const { Channel, ChannelVideo, ShortInteraction, ShortComment, User } = require('../models');
const { syncChannel } = require('../services/channelSyncService');
const instagramService = require('../services/instagramService');

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const FEED_TTL_MS = 15 * 1000;
const COUNT_TTL_MS = 60 * 1000;
const CHANNEL_TTL_MS = 5 * 60 * 1000;
const COMMENTS_TTL_MS = 5 * 1000;
const CACHE_MAX_ENTRIES = 2000;
const STALE_FACTOR = 4;

const FEED_DEFAULT_LIMIT = 10;
const FEED_MAX_LIMIT = 30;
const COMMENT_MAX_LENGTH = 500;
const MAX_SHORT_SECONDS = 180;
const IMPORT_MAX_PAGES = 6;
const IMPORT_INPUT_MAX_LENGTH = 300;
const CURSOR_MAX_LENGTH = 400;

const CHANNEL_ATTRS = ['id', 'name', 'handle', 'logoUrl', 'youtubeChannelId'];
const USER_ATTRS = ['id', 'fullName', 'avatar'];
const IMPORT_PAYLOAD_KEYS = ['videoUrl', 'url', 'shortUrl', 'link', 'videoId'];
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/* -------------------------------------------------------------------------- */
/* Logging & errors                                                           */
/* -------------------------------------------------------------------------- */

const stamp = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(stamp(), '[shorts]', ...a),
  warn: (...a) => console.warn(stamp(), '[shorts]', ...a),
  error: (...a) => console.error(stamp(), '[shorts]', ...a),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/* -------------------------------------------------------------------------- */
/* Short-form business rule (single source of truth)                          */
/* -------------------------------------------------------------------------- */

const isValidShortDuration = (seconds) =>
  Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SHORT_SECONDS;

// Fresh objects each call so Sequelize can never mutate shared state.
const durationFilter = () => ({ [Op.gt]: 0, [Op.lte]: MAX_SHORT_SECONDS });
const shortScope = (extra = {}) => ({ isShort: true, totalSeconds: durationFilter(), ...extra });
const invalidDurationFilter = () => [
  { totalSeconds: null },
  { totalSeconds: { [Op.lte]: 0 } },
  { totalSeconds: { [Op.gt]: MAX_SHORT_SECONDS } },
];

/* -------------------------------------------------------------------------- */
/* Cache: TTL + stale-while-revalidate + in-flight coalescing                 */
/* -------------------------------------------------------------------------- */

const store = new Map();
const inflight = new Map();
let generation = 0; // bumped on invalidation so in-flight loaders can't re-poison the cache

const cache = {
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
    if (store.has(key)) store.delete(key); // refresh insertion order
    else if (store.size >= CACHE_MAX_ENTRIES) store.delete(store.keys().next().value);
    const now = Date.now();
    store.set(key, { v, exp: now + ttl, stale: now + ttl * STALE_FACTOR });
  },
  deleteByPrefix(prefix) {
    for (const key of Array.from(store.keys())) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  },
  clear() {
    generation += 1;
    store.clear();
    inflight.clear();
  },
};

function refresh(key, ttl, loader) {
  if (inflight.has(key)) return inflight.get(key);
  const gen = generation;
  const p = Promise.resolve()
    .then(loader)
    .then((v) => {
      if (gen === generation) cache.set(key, v, ttl);
      return v;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

async function cached(key, ttl, loader) {
  const e = cache.getEntry(key);
  if (e && e.exp > Date.now()) return e.v;
  if (e) {
    // Stale: serve immediately, refresh in background (coalesced).
    refresh(key, ttl, loader).catch((err) => log.error(`cache refresh failed for ${key}: ${err.message}`));
    return e.v;
  }
  return refresh(key, ttl, loader);
}

const invalidateFeedCache = () => cache.clear();

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* -------------------------------------------------------------------------- */

function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** Accepts only simple scalar ids (blocks arrays/objects from query-string injection). */
function normalizeId(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

function durationToSeconds(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  try {
    const d = parse(iso);
    return Math.floor(
      (d.weeks || 0) * 604800 + (d.days || 0) * 86400 + (d.hours || 0) * 3600 + (d.minutes || 0) * 60 + (d.seconds || 0)
    );
  } catch (e) {
    log.warn(`could not parse duration "${iso}": ${e.message}`);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Cursor helpers (keyset pagination)                                         */
/* cursor = { date, id, lastChannelId } – lastChannelId prevents the first    */
/* item of the next page from repeating the last creator of the previous one. */
/* -------------------------------------------------------------------------- */

function encodeCursor(row, lastChannelId) {
  const payload = {
    d: new Date(row.publishedAt).toISOString(),
    i: String(row.id),
    c: lastChannelId == null ? null : String(lastChannelId),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > CURSOR_MAX_LENGTH) return null;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    let iso;
    let id;
    let lastChannelId = null;

    if (text.startsWith('{')) {
      const obj = JSON.parse(text);
      iso = obj.d;
      id = obj.i;
      lastChannelId = obj.c == null ? null : String(obj.c);
    } else {
      // Backwards compatible with legacy "<iso>|<id>" cursors.
      const [first, ...rest] = text.split('|');
      iso = first;
      id = rest.join('|');
    }

    const date = new Date(iso);
    if (!id || Number.isNaN(date.getTime())) return null;
    return { date, id: String(id), lastChannelId };
  } catch (_) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Counters                                                                   */
/* -------------------------------------------------------------------------- */

async function refreshShortsCount(channelId, transaction) {
  const shortsCount = await ChannelVideo.count({ where: shortScope({ channelId }), transaction });
  await Channel.update({ shortsCount }, { where: { id: channelId }, transaction });
  return shortsCount;
}

/**
 * Re-evaluates every video of a channel against the duration rule.
 *  - demote: any isShort video that is NOT 0 < totalSeconds <= 180 → isShort=false
 *  - promote (optional): any non-short video that satisfies the rule → isShort=true
 * Done as two set-based UPDATEs (no N+1 loops).
 */
async function reconcileChannelShorts(channelId, { promote = true, transaction } = {}) {
  const [demoted] = await ChannelVideo.update(
    { isShort: false },
    { where: { channelId, isShort: true, [Op.or]: invalidDurationFilter() }, transaction }
  );
  let promoted = 0;
  if (promote) {
    [promoted] = await ChannelVideo.update(
      { isShort: true },
      { where: { channelId, isShort: false, totalSeconds: durationFilter() }, transaction }
    );
  }
  return { promoted, demoted };
}

/* -------------------------------------------------------------------------- */
/* Feed                                                                       */
/* -------------------------------------------------------------------------- */

const feedWhere = (channelId) => {
  const where = shortScope({ isAvailable: true });
  if (channelId) where.channelId = channelId;
  return where;
};

async function attachLikes(rows, userId) {
  const liked = new Set();
  if (userId && rows.length > 0) {
    const ytIds = rows.filter(r => !r.id.startsWith('ig_')).map(r => r.id);
    const igIds = rows.filter(r => r.id.startsWith('ig_')).map(r => r.id);

    // Fetch YouTube likes
    if (ytIds.length > 0) {
      const interactions = await ShortInteraction.findAll({
        where: { userId, channelVideoId: { [Op.in]: ytIds }, type: 'like' },
        attributes: ['channelVideoId'],
        raw: true,
      });
      interactions.forEach((i) => liked.add(i.channelVideoId));
    }

    // Fetch Instagram likes
    if (igIds.length > 0) {
      const igLikes = await instagramService.getLikedSet(userId, igIds);
      igLikes.forEach(id => liked.add(id));
    }
  }
  return rows.map((r) => ({
    ...r,
    isLiked: liked.has(r.id),
    videoUrl: `https://www.youtube.com/watch?v=${r.youtubeVideoId}`,
  }));
}

/**
 * Creator diversity / interleaving (Instagram Reels style).
 *
 * Round-robin over creators in order of first appearance (recency), with an
 * adjacency guard: the next pick is always from a different creator than the
 * previous one when any other creator still has videos. Among candidates the
 * creator with the most remaining videos wins (ties → earliest/most recent),
 * which is equivalent to plain round-robin for equal queues but also avoids
 * unnecessary back-to-back repeats for uneven queues (e.g. A(1),B(2) → B A B).
 *
 * @param {object[]} rows   rows with a channelId
 * @param {number}   limit  max items to return
 * @param {*}        avoidFirstChannelId creator of the previously served item
 */
function interleaveByChannel(rows, limit = Infinity, avoidFirstChannelId = null) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const queues = new Map();
  for (const row of rows) {
    const cid = String(row.channelId);
    if (!queues.has(cid)) queues.set(cid, []);
    queues.get(cid).push(row);
  }
  const lists = Array.from(queues.entries()).map(([cid, items]) => ({ cid, items, idx: 0 }));

  const out = [];
  const max = Math.min(limit, rows.length);
  let last = avoidFirstChannelId == null ? null : String(avoidFirstChannelId);

  while (out.length < max) {
    let best = null;
    let fallback = null;
    for (const q of lists) {
      const remaining = q.items.length - q.idx;
      if (remaining <= 0) continue;
      if (!fallback) fallback = q;
      if (q.cid === last) continue;
      if (!best || remaining > best.items.length - best.idx) best = q;
    }
    const pick = best || fallback;
    if (!pick) break;
    out.push(pick.items[pick.idx]);
    pick.idx += 1;
    last = pick.cid;
  }
  return out;
}

async function countFeed(channelId) {
  return cached(`feedcount:${channelId || 'all'}`, COUNT_TTL_MS, () =>
    ChannelVideo.count({ where: feedWhere(channelId) })
  );
}

/**
 * Loads one page: a contiguous slice of `limit` rows in (publishedAt, id) order,
 * then (global feed only) interleaved by creator. Because the slice is contiguous,
 * keyset pagination stays exact – no video is ever skipped or duplicated.
 */
async function loadFeedPage({ channelId, cursor, offset, limit }) {
  const where = feedWhere(channelId);
  if (cursor) {
    where[Op.or] = [
      { publishedAt: { [Op.lt]: cursor.date } },
      { publishedAt: cursor.date, id: { [Op.lt]: cursor.id } },
    ];
  }

  const rows = await ChannelVideo.findAll({
    where,
    attributes: { exclude: ['description'] },
    include: [{ model: Channel, as: 'channel', attributes: CHANNEL_ATTRS, required: false }],
    order: [
      ['publishedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: limit + 1, // +1 to detect hasMore
    offset: cursor ? 0 : offset,
    raw: true,
    nest: true,
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  const data = channelId
    ? slice
    : interleaveByChannel(slice, limit, cursor ? cursor.lastChannelId : null);

  const tail = slice[slice.length - 1];
  const lastServed = data[data.length - 1];
  return {
    data,
    hasMore,
    nextCursor: hasMore && tail ? encodeCursor(tail, lastServed && lastServed.channelId) : null,
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

  const userId = req.user && req.user.id;
  const data = await attachLikes(pageData.data, userId);

  if (userId || req.headers.authorization) {
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

/* -------------------------------------------------------------------------- */
/* Public endpoints                                                           */
/* -------------------------------------------------------------------------- */

const feedEngineService = require('../services/feedEngineService');

exports.getShorts = asyncHandler(async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const cursor = req.query.cursor || null;
    const limit = parseInt(req.query.limit, 10) || 12;

    const result = await feedEngineService.getFeed(userId, cursor, limit);

    return res.status(200).json({
      success: true,
      data: result.data || result,
      nextCursor: result.nextCursor || null,
      hasMore: result.hasMore || false
    });
  } catch (err) {
    next(err);
  }
});

exports.getShortsByChannel = asyncHandler(async (req, res) => {
  const channelParam = String(req.params.channelId || '').trim();
  if (!/^[\w.@-]{1,64}$/.test(channelParam)) {
    return fail(res, 404, 'Channel not found.');
  }

  const channel = await cached(`channel:${channelParam}`, CHANNEL_TTL_MS, async () => {
    const parsedId = /^\d+$/.test(channelParam) ? parseInt(channelParam, 10) : NaN;
    const row = await Channel.findOne({
      where: {
        [Op.or]: [...(Number.isNaN(parsedId) ? [] : [{ id: parsedId }]), { youtubeChannelId: channelParam }],
      },
      attributes: ['id'],
      raw: true,
    });
    return row || false;
  });

  if (!channel) return fail(res, 404, 'Channel not found.');
  await serveFeed(req, res, channel.id);
});

exports.getInstagramStream = asyncHandler(async (req, res) => {
  const shortcode = req.params.shortcode;
  if (!shortcode || !/^[A-Za-z0-9_-]+$/.test(shortcode)) {
    return fail(res, 400, 'Invalid shortcode.');
  }

  // Step A (DB Direct Cache Check)
  try {
    const { InstagramReel } = require('../models');
    let reel = null;
    try {
      reel = await InstagramReel.findOne({ where: { shortcode }, attributes: ['videoUrl'], raw: true });
    } catch (e) {
      reel = await InstagramReel.findOne({ shortcode });
    }
    if (reel && reel.videoUrl && !reel.videoUrl.includes('instagram.com/reel/') && (reel.videoUrl.includes('.mp4') || reel.videoUrl.includes('cdninstagram.com'))) {
      log.info(`[shortsController] Found cached direct videoUrl in InstagramReel DB for ${shortcode}`);
      return res.redirect(302, reel.videoUrl);
    }
  } catch (dbErr) {
    log.warn(`[shortsController] DB cache lookup failed for ${shortcode}: ${dbErr.message}`);
  }

  // Step B (Authenticated Live Stream Fetch)
  try {
    const sessionId = process.env.INSTAGRAM_SESSION_ID;
    const response = await axios.get(`https://www.instagram.com/reel/${shortcode}/?__a=1&__d=dis`, {
      headers: {
        'Cookie': sessionId ? `sessionid=${sessionId}; ds_user_id=${sessionId.split('%')[0]}` : '',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': '*/*'
      },
      validateStatus: () => true,
      timeout: 9000
    });

    // Step C (URL Extraction & Cache)
    let rawUrl =
      response.data?.items?.[0]?.video_versions?.[0]?.url ||
      response.data?.graphql?.shortcode_media?.video_url;

    if (!rawUrl && typeof response.data === 'string') {
      const ogMatch = response.data.match(/<meta property="og:video" content="([^"]+)"/i);
      const jsonMatch = response.data.match(/"video_url":"(https:[^"]+)"/i);
      rawUrl = ogMatch ? ogMatch[1] : (jsonMatch ? jsonMatch[1] : null);
    }

    if (rawUrl) {
      const cleanUrl = rawUrl.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
      try {
        const { InstagramReel } = require('../models');
        if (typeof InstagramReel.updateOne === 'function') {
          await InstagramReel.updateOne({ shortcode }, { $set: { videoUrl: cleanUrl } });
        } else {
          await InstagramReel.update({ videoUrl: cleanUrl }, { where: { shortcode } });
        }
      } catch (cacheErr) {
        log.warn(`[shortsController] Cache update failed for ${shortcode}: ${cacheErr.message}`);
      }
      return res.redirect(302, cleanUrl);
    }

    // Step D (Eliminate 404 Crashes): Fall back to Instagram embed redirect
    return res.redirect(302, `https://www.instagram.com/reel/${shortcode}/embed/`);
  } catch (err) {
    log.error(`ig-stream proxy error for ${shortcode}: ${err.message}`);
    return res.redirect(302, `https://www.instagram.com/reel/${shortcode}/embed/`);
  }
});

exports.reportUnavailable = asyncHandler(async (req, res) => {
  return res.status(200).json({ success: true });
});

exports.toggleLikeShort = asyncHandler(async (req, res) => {
  const videoId = normalizeId(req.params.id);
  if (!videoId) return fail(res, 400, 'Invalid video id.');
  const userId = req.user.id;

  if (videoId.startsWith('ig_')) {
    const { isLiked, likesCount } = await instagramService.toggleLike(userId, videoId);
    return res.status(200).json({
      success: true,
      isLiked,
      likesCount,
      message: isLiked ? 'Instagram reel liked successfully.' : 'Instagram reel unliked successfully.',
    });
  }

  const video = await ChannelVideo.findOne({ where: shortScope({ id: videoId }), attributes: ['id'], raw: true });
  if (!video) return fail(res, 404, 'Short video not found.');

  // Interaction row + counter change commit together or not at all.
  const { isLiked, likesCount } = await ChannelVideo.sequelize.transaction(async (transaction) => {
    const removed = await ShortInteraction.destroy({
      where: { userId, channelVideoId: videoId, type: 'like' },
      transaction,
    });

    let liked;
    if (removed > 0) {
      // Atomic decrement that can never go below zero.
      await ChannelVideo.decrement('likesCount', {
        by: removed,
        where: { id: videoId, likesCount: { [Op.gte]: removed } },
        transaction,
      });
      liked = false;
    } else {
      const [, created] = await ShortInteraction.findOrCreate({
        where: { userId, channelVideoId: videoId, type: 'like' },
        defaults: { userId, channelVideoId: videoId, type: 'like' },
        transaction,
      });
      // If a concurrent request already created it, don't double count.
      if (created) await ChannelVideo.increment('likesCount', { by: 1, where: { id: videoId }, transaction });
      liked = true;
    }

    const fresh = await ChannelVideo.findByPk(videoId, { attributes: ['likesCount'], raw: true, transaction });
    return { isLiked: liked, likesCount: Math.max(0, (fresh && fresh.likesCount) || 0) };
  });

  res.status(200).json({
    success: true,
    isLiked,
    likesCount,
    message: isLiked ? 'Short liked successfully.' : 'Short unliked successfully.',
  });
});

exports.addShortComment = asyncHandler(async (req, res) => {
  const videoId = normalizeId(req.params.id);
  if (!videoId) return fail(res, 400, 'Invalid video id.');
  const userId = req.user.id;
  const text = req.body && typeof req.body.comment === 'string' ? req.body.comment.trim() : '';

  if (!text) return fail(res, 400, 'Comment text is required.');
  if (text.length > COMMENT_MAX_LENGTH) {
    return fail(res, 400, `Comment must be at most ${COMMENT_MAX_LENGTH} characters.`);
  }

  const video = await ChannelVideo.findOne({ where: shortScope({ id: videoId }), attributes: ['id'], raw: true });
  if (!video) return fail(res, 404, 'Short video not found.');

  const newComment = await ChannelVideo.sequelize.transaction(async (transaction) => {
    const created = await ShortComment.create({ userId, channelVideoId: videoId, comment: text }, { transaction });
    await ChannelVideo.increment('commentsCount', { by: 1, where: { id: videoId }, transaction });
    return created;
  });

  cache.deleteByPrefix(`comments:${videoId}:`);

  const [createdWithUser, fresh] = await Promise.all([
    ShortComment.findByPk(newComment.id, {
      include: [{ model: User, as: 'user', attributes: USER_ATTRS }],
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

exports.getShortComments = asyncHandler(async (req, res) => {
  const videoId = normalizeId(req.params.id);
  if (!videoId) return fail(res, 400, 'Invalid video id.');
  const page = clampInt(req.query.page, 1, 1, 10000);
  const limit = clampInt(req.query.limit, 20, 1, 50);
  const offset = (page - 1) * limit;

  const result = await cached(`comments:${videoId}:${page}:${limit}`, COMMENTS_TTL_MS, async () => {
    const video = await ChannelVideo.findOne({ where: shortScope({ id: videoId }), attributes: ['id'], raw: true });
    if (!video) return null;

    const { count, rows } = await ShortComment.findAndCountAll({
      where: { channelVideoId: videoId },
      include: [{ model: User, as: 'user', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });
    return { count, rows: rows.map((r) => r.toJSON()) };
  });

  if (!result) return fail(res, 404, 'Short video not found.');

  res.status(200).json({
    success: true,
    currentPage: page,
    totalPages: Math.ceil(result.count / limit) || 1,
    totalItems: result.count,
    data: result.rows,
  });
});

/* -------------------------------------------------------------------------- */
/* Admin endpoints                                                            */
/* -------------------------------------------------------------------------- */

exports.adminGetShorts = asyncHandler(async (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 100000);
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const offset = (page - 1) * limit;
  const { search } = req.query;

  const whereClause = shortScope();

  if (req.query.channelId !== undefined && req.query.channelId !== '') {
    const channelId = normalizeId(req.query.channelId);
    if (!channelId) return fail(res, 400, 'Invalid channelId.');
    whereClause.channelId = channelId;
  }
  if (search && typeof search === 'string') {
    const safe = search.slice(0, 100).replace(/[%_\\]/g, '\\$&');
    whereClause.title = { [Op.like]: `%${safe}%` };
  }

  const { count, rows } = await ChannelVideo.findAndCountAll({
    where: whereClause,
    include: [{ model: Channel, as: 'channel', attributes: ['id', 'name', 'handle', 'logoUrl', 'isShortsOnly'] }],
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

exports.adminToggleChannelShortsOnly = asyncHandler(async (req, res) => {
  const channelId = normalizeId(req.params.id);
  if (!channelId) return fail(res, 400, 'Invalid channel id.');

  const channel = await Channel.findByPk(channelId);
  if (!channel) return fail(res, 404, 'Channel not found.');

  // STRICT: toggling a mode never blindly flags videos. Every video of the channel is
  // evaluated against 0 < totalSeconds <= 180; long-form is always forced to isShort=false.
  const { promoted, demoted, shortsCount } = await ChannelVideo.sequelize.transaction(async (transaction) => {
    channel.isShortsOnly = !channel.isShortsOnly;
    await channel.save({ transaction });

    const result = await reconcileChannelShorts(channelId, { promote: true, transaction });
    const count = await refreshShortsCount(channelId, transaction);
    return { ...result, shortsCount: count };
  });

  invalidateFeedCache();
  log.info(`channel ${channelId} isShortsOnly=${channel.isShortsOnly} promoted=${promoted} demoted=${demoted}`);

  res.status(200).json({
    success: true,
    message: `Channel ${channel.name} mode updated safely. Long videos are excluded.`,
    data: channel,
    stats: { promoted, demoted, shortsCount },
  });
});

exports.adminToggleVideoShort = asyncHandler(async (req, res) => {
  const videoId = normalizeId(req.params.id);
  if (!videoId) return fail(res, 400, 'Invalid video id.');

  const video = await ChannelVideo.findByPk(videoId);
  if (!video) return fail(res, 404, 'Video not found.');

  // Never allow a video outside 0 < duration <= 180 to become a Short.
  if (!video.isShort && !isValidShortDuration(video.totalSeconds)) {
    return fail(
      res,
      400,
      `Cannot mark video as Short because its duration (${video.totalSeconds || 0}s) is not within 1-${MAX_SHORT_SECONDS} seconds.`
    );
  }

  video.isShort = !video.isShort;
  await video.save();
  await refreshShortsCount(video.channelId);
  invalidateFeedCache();
  if (!video.isShort) await removeFromCatalog([video.id]);

  res.status(200).json({
    success: true,
    message: `Video "${video.title}" status updated.`,
    data: video,
  });
});

exports.adminDeleteShort = asyncHandler(async (req, res) => {
  const videoId = normalizeId(req.params.id);
  if (!videoId) return fail(res, 400, 'Invalid video id.');

  const video = await ChannelVideo.findByPk(videoId);
  if (!video) return fail(res, 404, 'Video not found.');

  const { channelId } = video;
  await video.destroy();
  await refreshShortsCount(channelId);
  invalidateFeedCache();
  await removeFromCatalog([videoId]);

  res.status(200).json({ success: true, message: 'Short video deleted successfully.' });
});

/* -------------------------------------------------------------------------- */
/* Import: input extraction & detection                                       */
/* -------------------------------------------------------------------------- */

/**
 * Pulls the YouTube URL/ID out of whatever the client sent:
 * JSON object (videoUrl|url|shortUrl|link|videoId), raw string / text body,
 * JSON-encoded string, array of strings, Buffer, or the query string.
 * Returns a trimmed string or null. Never throws.
 */
function extractImportInput(req) {
  const pick = (src, allowJson) => {
    if (src === undefined || src === null) return null;
    if (Buffer.isBuffer(src)) src = src.toString('utf8');

    if (typeof src === 'string') {
      const s = src.trim();
      if (!s) return null;
      if (allowJson && (s[0] === '{' || s[0] === '[' || s[0] === '"')) {
        try {
          const nested = pick(JSON.parse(s), false);
          if (nested) return nested;
        } catch (_) {
          /* not JSON – treat as plain text */
        }
      }
      return s;
    }

    if (Array.isArray(src)) {
      for (const item of src) {
        const v = pick(item, false);
        if (v) return v;
      }
      return null;
    }

    if (typeof src === 'object') {
      for (const key of IMPORT_PAYLOAD_KEYS) {
        const v = src[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    return null;
  };

  try {
    return pick(req.body, true) || pick(req.query, false) || null;
  } catch (_) {
    return null;
  }
}

function detectYouTubeInput(input) {
  const unknown = { type: 'unknown', value: null };
  if (typeof input !== 'string') return unknown;
  const s = input.trim();
  if (!s || s.length > IMPORT_INPUT_MAX_LENGTH) return unknown;

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

  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return { type: 'video', value: v };
  if ((m = path.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/))) return { type: 'video', value: m[1] };

  return unknown;
}

/* -------------------------------------------------------------------------- */
/* Import: YouTube API access                                                 */
/* -------------------------------------------------------------------------- */

const getApiKey = () => process.env.YOUTUBE_API_KEY;

async function ytGet(resource, params) {
  const { data } = await axios.get(`https://www.googleapis.com/youtube/v3/${resource}`, {
    params: { ...params, key: getApiKey() },
    timeout: 10000,
  });
  return data;
}

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

function pickThumbnail(thumbnails, order) {
  if (!thumbnails) return null;
  for (const size of order) {
    if (thumbnails[size] && thumbnails[size].url) return thumbnails[size].url;
  }
  return null;
}

function channelPayloadFromYouTube(chData, { shortsOnly = false } = {}) {
  const sn = chData.snippet || {};
  const st = chData.statistics || {};
  const cd = chData.contentDetails || {};
  return {
    youtubeChannelId: chData.id,
    name: sn.title || 'Unknown Channel',
    handle: sn.customUrl || null,
    logoUrl: pickThumbnail(sn.thumbnails, ['high', 'medium']),
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

/** Idempotent: safe under concurrent imports of the same channel. */
async function findOrCreateChannelFromYouTubeData(chData, opts) {
  const existing = await Channel.findOne({ where: { youtubeChannelId: chData.id } });
  if (existing) return existing;
  try {
    return await Channel.create(channelPayloadFromYouTube(chData, opts));
  } catch (err) {
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
      [Op.or]: [{ handle: `@${detected.value}` }, { handle: detected.value }, { name: detected.value }],
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Import: operations (throw HttpError; the handler maps to responses)        */
/* -------------------------------------------------------------------------- */

const importLocks = new Set();

async function importChannel(detected) {
  const lockKey = `${detected.kind}:${String(detected.value).toLowerCase()}`;
  if (importLocks.has(lockKey)) {
    throw new HttpError(409, 'This channel is already being imported. Please wait.');
  }
  importLocks.add(lockKey);

  try {
    let channel = await findChannelInDb(detected);

    if (!channel) {
      log.info(`import: channel not in DB, fetching from YouTube: ${detected.value}`);
      const chData = await fetchChannelFromYouTube(detected);
      if (!chData) throw new HttpError(404, 'Channel not found on YouTube.');
      channel = await findOrCreateChannelFromYouTubeData(chData, { shortsOnly: detected.shortsOnly });
    }

    log.info(`import: syncing channel "${channel.name}" (id=${channel.id})`);
    const newShortsCount = await syncChannel(channel, { skipAlerts: true, maxPages: IMPORT_MAX_PAGES });

    // Safety net: whatever the sync flagged, nothing outside 1-180s may stay a Short.
    const { demoted } = await reconcileChannelShorts(channel.id, { promote: false });
    if (demoted > 0) log.warn(`import: demoted ${demoted} non-short videos for channel ${channel.id}`);

    const shortsCount = await refreshShortsCount(channel.id);
    invalidateFeedCache();

    return {
      message: `Channel "${channel.name}" synced. Added ${newShortsCount} new videos.`,
      data: { channelId: channel.id, name: channel.name, newShortsCount, shortsCount },
    };
  } finally {
    importLocks.delete(lockKey);
  }
}

async function importVideo(videoId, force) {
  const videoRes = await ytGet('videos', { part: 'snippet,contentDetails,statistics', id: videoId });
  const ytVideo = (videoRes.items || [])[0];
  if (!ytVideo) throw new HttpError(404, 'Video not found on YouTube.');

  const snippet = ytVideo.snippet || {};
  const contentDetails = ytVideo.contentDetails || {};
  const statistics = ytVideo.statistics || {};

  const totalSeconds = durationToSeconds(contentDetails.duration);
  const qualifiesAsShort = isValidShortDuration(totalSeconds);

  if (!force && !qualifiesAsShort) {
    throw new HttpError(
      400,
      `This does not look like a Short (duration ${totalSeconds}s, must be 1-${MAX_SHORT_SECONDS}s).`
    );
  }

  let channel = await Channel.findOne({ where: { youtubeChannelId: snippet.channelId } });
  if (!channel) {
    const chData = await fetchChannelFromYouTube({ kind: 'id', value: snippet.channelId });
    if (!chData) throw new HttpError(502, "Could not fetch the video's channel from YouTube.");
    channel = await findOrCreateChannelFromYouTubeData(chData, { shortsOnly: false });
  }

  const fields = {
    channelId: channel.id,
    title: snippet.title || 'Untitled Short',
    description: snippet.description || '',
    thumbnailUrl: pickThumbnail(snippet.thumbnails, ['high', 'medium', 'default']) || '',
    durationStr: contentDetails.duration || '',
    totalSeconds,
    viewCount: statistics.viewCount ? parseInt(statistics.viewCount, 10) : 0,
    publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : new Date(),
    isAvailable: true,
    // `force` can import long-form for the library, but it can NEVER become a Short.
    isShort: qualifiesAsShort,
  };

  const [dbVideo, created] = await ChannelVideo.findOrCreate({
    where: { youtubeVideoId: videoId },
    defaults: { ...fields, youtubeVideoId: videoId },
  });
  if (!created) await dbVideo.update(fields);

  await refreshShortsCount(channel.id);
  invalidateFeedCache();

  return {
    message: qualifiesAsShort
      ? `Short "${dbVideo.title}" imported successfully.`
      : `Video "${dbVideo.title}" imported as long-form (not added to Shorts).`,
    data: dbVideo,
  };
}

/* -------------------------------------------------------------------------- */
/* Import: endpoint  POST /api/admin/shorts/import-single                     */
/* -------------------------------------------------------------------------- */

function mapImportError(err) {
  if (err instanceof HttpError) return { status: err.status, message: err.message };

  if (err && err.isAxiosError) {
    const upstream = err.response && err.response.status;
    if (upstream === 403 || upstream === 429) return { status: 503, message: 'YouTube API quota or permission issue.' };
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return { status: 504, message: 'YouTube API request timed out.' };
    }
    return { status: 502, message: 'YouTube API request failed.' };
  }

  return { status: 500, message: IS_PRODUCTION ? 'Import failed.' : (err && err.message) || 'Import failed.' };
}

exports.adminImportSingleShort = asyncHandler(async (req, res) => {
  try {
    const rawInput = extractImportInput(req);

    if (!rawInput) {
      return fail(
        res,
        400,
        `YouTube URL or ID is required. Send it as one of: ${IMPORT_PAYLOAD_KEYS.join(', ')} (JSON body), a plain-text body, or a query parameter.`
      );
    }
    if (rawInput.length > IMPORT_INPUT_MAX_LENGTH) {
      return fail(res, 400, `Input is too long (max ${IMPORT_INPUT_MAX_LENGTH} characters).`);
    }
    if (!getApiKey()) {
      log.error('YOUTUBE_API_KEY is not configured');
      return fail(res, 500, 'YouTube API key not configured on backend.');
    }

    const detected = detectYouTubeInput(rawInput);
    if (detected.type === 'unknown') {
      return fail(res, 400, 'Invalid YouTube URL or ID. Please provide a valid channel or video link.');
    }

    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    const force = body.force === true || body.force === 'true';

    const result =
      detected.type === 'channel' ? await importChannel(detected) : await importVideo(detected.value, force);

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const { status, message } = mapImportError(err);
    if (status >= 500) log.error(`import failed (${status}): ${err && err.stack ? err.stack : err}`);
    else log.warn(`import rejected (${status}): ${message}`);
    return fail(res, status, message);
  }
});

/* -------------------------------------------------------------------------- */
/* NEVER-REPEAT FEED   GET /api/feed/shorts   POST /api/feed/track-view         */
/*                                                                            */
/* - Seen history per viewer in Redis (sorted set => O(1) lookup + prune oldest) */
/* - One atomic Lua call: exhaustion reset (>=95%) + unseen candidate pick     */
/* - Ranking = engagement_score x freshness decay (computed in PostgreSQL)     */
/* - Views are batch-flushed to PostgreSQL (user_seen_videos) asynchronously   */
/* - If Redis is down, falls back to a PostgreSQL NOT IN (seen ids) query      */
/* Requires: ioredis, Redis >= 6.2 (non-cluster), PostgreSQL.                  */
/* -------------------------------------------------------------------------- */

const NF = {
  poolFactor: 4, // candidate pool = limit * poolFactor, diversified down to `limit`
  categoryLookahead: 6,
  ranking: { wLike: 3, wComment: 5, wView: 0.02, halfLifeHours: 72, floor: 0.15 },
  catalog: { refreshMs: 60 * 1000, batchSize: 5000, maxSize: 200000, lockTtlMs: 120 * 1000, hydrateTtlMs: 30 * 1000, hydrateMax: 5000 },
  history: {
    resetThreshold: Number(process.env.FEED_RESET_THRESHOLD) || 0.95, // reset when seen >= 95% of catalog
    keepRatio: Number(process.env.FEED_RESET_KEEP_RATIO) || 0.2, // after reset keep newest 20% excluded
    maxEntries: 50000,
    ttlSec: 90 * 24 * 3600,
    anonTtlSec: 7 * 24 * 3600,
    servedTtlSec: 30 * 60, // served-but-not-yet-tracked hold (prevents repeats from prefetch/fast swipes)
    maxScan: 3000,
    randomSample: 300,
  },
  tracking: {
    maxEvents: 50,
    ratePerMin: 300,
    queueMax: 200000,
    flushMs: 2000,
    flushBatch: 1000,
    maxBatchesPerTick: 10,
    maxFailures: 5,
    localBufferMax: 10000,
    maxWatchMs: 60 * 60 * 1000,
  },
};

const RP = process.env.FEED_REDIS_PREFIX || 'rcm:feed:';
const RK = {
  catalog: `${RP}catalog`, // ZSET videoId -> rank score
  catalogLock: `${RP}catalog:lock`,
  catalogTmp: (t) => `${RP}catalog:tmp:${t}`,
  seen: (v) => `${RP}seen:${v}`, // ZSET videoId -> viewedAtMs
  served: (v) => `${RP}served:${v}`, // SET (TTL)
  loaded: (v) => `${RP}loaded:${v}`,
  last: (v) => `${RP}last:${v}`,
  rate: (v) => `${RP}rate:${v}`,
  viewQueue: `${RP}viewqueue`, // LIST of JSON events
  viewDead: `${RP}viewqueue:dead`,
};

/* ---------------------- durable seen history (PostgreSQL) ------------------- */
// Defined inline (no separate model file). Table is created on first start via sync().
// No foreign keys on purpose: batch upserts must never fail because a user/video was deleted.
const sequelize = ChannelVideo.sequelize;
const UserSeenVideo =
  sequelize.models.UserSeenVideo ||
  sequelize.define(
    'UserSeenVideo',
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.BIGINT, allowNull: false },
      channelVideoId: { type: DataTypes.BIGINT, allowNull: false },
      firstSeenAt: { type: DataTypes.DATE, allowNull: false },
      lastSeenAt: { type: DataTypes.DATE, allowNull: false },
      viewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      watchMs: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    {
      tableName: 'user_seen_videos',
      timestamps: true,
      indexes: [
        { unique: true, name: 'uq_user_seen_videos_user_video', fields: ['userId', 'channelVideoId'] },
        { name: 'idx_user_seen_videos_user_last', fields: ['userId', 'lastSeenAt'] },
      ],
    }
  );

/* --------------------------------- Redis ------------------------------------ */

const FEED_PICK_LUA = `
local catalog, seen, served = KEYS[1], KEYS[2], KEYS[3]
local want      = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local keepRatio = tonumber(ARGV[3])
local maxScan   = tonumber(ARGV[4])
local sample    = tonumber(ARGV[5])

local total = redis.call('ZCARD', catalog)
if total == 0 then return {0, 0, 'empty', {}} end

-- Drop the OLDEST seen entries so only the newest keepRatio of the catalog stays excluded.
local function prune()
  local size = redis.call('ZCARD', seen)
  local keep = math.min(math.floor(total * keepRatio), total - 1)
  if keep < 0 then keep = 0 end
  if size > keep then
    redis.call('ZREMRANGEBYRANK', seen, 0, size - keep - 1)
  end
  redis.call('DEL', served)
end

local function isUnseen(id)
  return redis.call('ZSCORE', seen, id) == false and redis.call('SISMEMBER', served, id) == 0
end

local function pick()
  local out, picked = {}, {}
  local pos, scanned, chunk = 0, 0, 200
  local mode = 'ranked'
  while #out < want and scanned < maxScan and pos < total do
    local ids = redis.call('ZREVRANGE', catalog, pos, pos + chunk - 1)
    if #ids == 0 then break end
    for _, id in ipairs(ids) do
      if isUnseen(id) then
        out[#out + 1] = id
        picked[id] = true
        if #out >= want then break end
      end
    end
    pos = pos + #ids
    scanned = scanned + #ids
  end
  -- Top of the ranking is mostly seen: sample randomly so cost stays bounded for heavy users.
  if #out < want and scanned >= maxScan and sample > 0 then
    mode = 'sampled'
    local ok, ids = pcall(redis.call, 'ZRANDMEMBER', catalog, sample)
    if ok and type(ids) == 'table' then
      for _, id in ipairs(ids) do
        if not picked[id] and isUnseen(id) then
          out[#out + 1] = id
          picked[id] = true
          if #out >= want then break end
        end
      end
    end
  end
  return out, mode
end

local reset = 0
local used = redis.call('ZCARD', seen) + redis.call('SCARD', served)
if used >= threshold * total then
  prune()
  reset = 1
end

local out, mode = pick()
if #out == 0 and reset == 0 then
  prune()
  reset = 1
  out, mode = pick()
end
return {reset, total, mode, out}
`;

const POP_BATCH_LUA = `
local n = tonumber(ARGV[1])
local items = redis.call('LRANGE', KEYS[1], 0, n - 1)
if #items > 0 then redis.call('LTRIM', KEYS[1], #items, -1) end
return items
`;

const COMPARE_DEL_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

let redisClient = null;
let lastRedisErrLog = 0;

function getRedis() {
  if (redisClient) return redisClient;
  const Redis = require('ioredis'); // lazy: the rest of this controller works even if Redis is not installed
  redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail fast while disconnected -> PostgreSQL fallback instead of hanging
    commandTimeout: Number(process.env.FEED_REDIS_TIMEOUT_MS) || 1000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redisClient.on('error', (err) => {
    const now = Date.now();
    if (now - lastRedisErrLog > 10000) {
      lastRedisErrLog = now;
      log.error(`redis error: ${err.message}`);
    }
  });
  redisClient.defineCommand('feedPick', { numberOfKeys: 3, lua: FEED_PICK_LUA });
  redisClient.defineCommand('popBatch', { numberOfKeys: 1, lua: POP_BATCH_LUA });
  redisClient.defineCommand('compareDel', { numberOfKeys: 1, lua: COMPARE_DEL_LUA });
  return redisClient;
}

function assertPipeline(results) {
  if (!results) throw new Error('redis pipeline returned no results');
  for (const [err] of results) if (err) throw err;
  return results;
}

/* ------------------------------- viewer identity ---------------------------- */

/** Authenticated user (req.user.id) or anonymous `X-Device-Id` header (Redis-only history). */
function resolveViewer(req) {
  if (req.user && req.user.id != null) return { key: `u:${req.user.id}`, userId: req.user.id };
  const device = req.headers['x-device-id'];
  if (typeof device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(device)) return { key: `d:${device}`, userId: null };
  return null;
}

const viewerTtl = (viewer) => (viewer.userId ? NF.history.ttlSec : NF.history.anonTtlSec);

/* ------------------------------- seen history ------------------------------- */

async function getViewerState(viewer) {
  const results = assertPipeline(
    await getRedis().pipeline().get(RK.loaded(viewer.key)).get(RK.last(viewer.key)).exec()
  );
  let last = null;
  if (results[1][1]) {
    try {
      last = JSON.parse(results[1][1]);
    } catch (_) {
      last = null;
    }
  }
  return { loaded: results[0][1] === '1', last };
}

/** Atomic: exhaustion check/reset + best-ranked UNSEEN ids (catalog minus seen minus served). */
async function pickUnseen(viewer, poolSize) {
  const h = NF.history;
  const [reset, total, mode, ids] = await getRedis().feedPick(
    RK.catalog,
    RK.seen(viewer.key),
    RK.served(viewer.key),
    poolSize,
    h.resetThreshold,
    h.keepRatio,
    h.maxScan,
    h.randomSample
  );
  return { reset: Number(reset) === 1, catalogSize: Number(total), mode, ids: ids || [] };
}

const historyLoading = new Map();

/** Cold Redis / eviction: restore the user's newest history from PostgreSQL (deduped per user). */
function ensureHistoryLoaded(viewer) {
  if (!viewer.userId) return Promise.resolve();
  if (historyLoading.has(viewer.key)) return historyLoading.get(viewer.key);
  const p = loadHistoryFromDb(viewer).finally(() => historyLoading.delete(viewer.key));
  historyLoading.set(viewer.key, p);
  return p;
}

async function loadHistoryFromDb(viewer) {
  const rows = await UserSeenVideo.findAll({
    where: { userId: viewer.userId },
    attributes: ['channelVideoId', 'lastSeenAt'],
    order: [['lastSeenAt', 'DESC']],
    limit: NF.history.maxEntries,
    raw: true,
  });

  const redis = getRedis();
  const seenKey = RK.seen(viewer.key);
  for (let i = 0; i < rows.length; i += 1000) {
    const args = [];
    for (const r of rows.slice(i, i + 1000)) args.push(new Date(r.lastSeenAt).getTime(), String(r.channelVideoId));
    // NX: never overwrite a newer score written by a concurrent track-view.
    assertPipeline(await redis.pipeline().zadd(seenKey, 'NX', ...args).exec());
  }

  const pipe = redis.pipeline();
  if (rows.length > 0) pipe.expire(seenKey, viewerTtl(viewer));
  pipe.set(RK.loaded(viewer.key), '1', 'EX', viewerTtl(viewer));
  assertPipeline(await pipe.exec());
  if (rows.length > 0) log.info(`restored ${rows.length} seen ids for ${viewer.key} from PostgreSQL`);
}

/** Hold just-served videos until track-view arrives. Never throws. */
async function markServed(viewer, rows) {
  if (!rows.length) return;
  try {
    const lastItem = rows[rows.length - 1];
    const pipe = getRedis().pipeline();
    pipe.sadd(RK.served(viewer.key), ...rows.map((r) => String(r.id)));
    pipe.expire(RK.served(viewer.key), NF.history.servedTtlSec);
    pipe.set(
      RK.last(viewer.key),
      JSON.stringify({ c: lastItem.channelId == null ? null : String(lastItem.channelId), k: categoryOf(lastItem) }),
      'EX',
      NF.history.servedTtlSec
    );
    assertPipeline(await pipe.exec());
  } catch (err) {
    log.warn(`markServed failed for ${viewer.key}: ${err.message}`);
  }
}

/** Only real, active shorts (present in the catalog) may enter seen history. */
async function filterKnownVideos(ids) {
  const pipe = getRedis().pipeline();
  ids.forEach((id) => pipe.zscore(RK.catalog, id));
  const results = assertPipeline(await pipe.exec());
  const known = new Set();
  results.forEach(([, score], i) => {
    if (score !== null && score !== undefined) known.add(ids[i]);
  });
  return known;
}

/** Instant seen update + served release + durable enqueue: ONE pipeline round trip. */
async function recordViews(viewer, events) {
  const now = Date.now();
  const seenKey = RK.seen(viewer.key);
  const zargs = [];
  events.forEach((e, i) => zargs.push(now + i, e.videoId));

  const pipe = getRedis().pipeline();
  pipe.zadd(seenKey, ...zargs); // 0
  pipe.srem(RK.served(viewer.key), ...events.map((e) => e.videoId)); // 1
  pipe.expire(seenKey, viewerTtl(viewer)); // 2
  pipe.zremrangebyrank(seenKey, 0, -(NF.history.maxEntries + 1)); // 3 hard cap, drops oldest
  pipe.zcard(seenKey); // 4
  if (viewer.userId) enqueueViews(pipe, viewer.userId, events, now); // 5,6

  const results = assertPipeline(await pipe.exec());
  return { seenCount: Number(results[4][1]) || 0 };
}

async function isTrackRateLimited(viewer) {
  try {
    const redis = getRedis();
    const key = RK.rate(viewer.key);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60);
    return n > NF.tracking.ratePerMin;
  } catch (_) {
    return false; // fail open
  }
}

/* --------------------- batched view persistence (Redis -> PG) ---------------- */

const localViewBuffer = [];
let flushing = false;
let flushFailures = 0;
let seenTableReady = Promise.resolve();

const toViewEvent = (userId, e, ts) => ({
  u: userId,
  v: String(e.videoId),
  t: ts,
  w: Math.min(Math.max(Number(e.watchMs) || 0, 0), NF.tracking.maxWatchMs),
  c: e.completed ? 1 : 0,
});

function enqueueViews(pipe, userId, events, ts) {
  pipe.rpush(RK.viewQueue, ...events.map((e) => JSON.stringify(toViewEvent(userId, e, ts))));
  pipe.ltrim(RK.viewQueue, -NF.tracking.queueMax, -1); // bounded memory; drops OLDEST when overloaded
}

/** Redis down: keep events in a bounded in-process buffer and flush straight to PostgreSQL. */
function bufferViewsLocally(userId, events) {
  const ts = Date.now();
  for (const e of events) {
    if (localViewBuffer.length >= NF.tracking.localBufferMax) localViewBuffer.shift();
    localViewBuffer.push(toViewEvent(userId, e, ts));
  }
}

function parseViewItems(raw) {
  const out = [];
  for (const s of raw) {
    try {
      const o = JSON.parse(s);
      if (o && o.u != null && o.v && Number.isFinite(o.t)) out.push(o);
    } catch (_) {
      /* skip corrupt entry */
    }
  }
  return out;
}

function aggregateViews(items) {
  const map = new Map();
  for (const it of items) {
    const key = `${it.u}:${it.v}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { userId: it.u, videoId: it.v, first: it.t, last: it.t, count: 1, watch: it.w || 0, done: it.c === 1 });
    } else {
      cur.first = Math.min(cur.first, it.t);
      cur.last = Math.max(cur.last, it.t);
      cur.count += 1;
      cur.watch += it.w || 0;
      cur.done = cur.done || it.c === 1;
    }
  }
  return Array.from(map.values());
}

async function upsertSeenRows(rows) {
  if (rows.length === 0) return;
  await seenTableReady;
  const table = sequelize.getQueryInterface().queryGenerator.quoteTable(UserSeenVideo.getTableName());
  const now = new Date();

  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    const replacements = [];
    for (const r of chunk) {
      replacements.push(r.userId, r.videoId, new Date(r.first), new Date(r.last), r.count, r.watch, r.done, now, now);
    }
    await sequelize.query(
      `INSERT INTO ${table} AS usv
         ("userId","channelVideoId","firstSeenAt","lastSeenAt","viewCount","watchMs","completed","createdAt","updatedAt")
       VALUES ${placeholders}
       ON CONFLICT ("userId","channelVideoId") DO UPDATE SET
         "firstSeenAt" = LEAST(usv."firstSeenAt", EXCLUDED."firstSeenAt"),
         "lastSeenAt"  = GREATEST(usv."lastSeenAt", EXCLUDED."lastSeenAt"),
         "viewCount"   = usv."viewCount" + EXCLUDED."viewCount",
         "watchMs"     = usv."watchMs" + EXCLUDED."watchMs",
         "completed"   = usv."completed" OR EXCLUDED."completed",
         "updatedAt"   = EXCLUDED."updatedAt"`,
      { replacements, type: QueryTypes.INSERT }
    );
  }
}

/** Drains the local buffer, then the Redis queue. Failed batches are requeued, then dead-lettered. */
async function flushViewEvents() {
  if (flushing) return 0;
  flushing = true;
  let persisted = 0;
  const t = NF.tracking;

  try {
    while (localViewBuffer.length > 0) {
      const batch = localViewBuffer.splice(0, t.flushBatch);
      try {
        await upsertSeenRows(aggregateViews(batch));
        persisted += batch.length;
      } catch (err) {
        localViewBuffer.unshift(...batch);
        log.error(`local view buffer flush failed: ${err.message}`);
        break;
      }
    }

    const redis = getRedis();
    for (let n = 0; n < t.maxBatchesPerTick; n += 1) {
      let raw;
      try {
        raw = await redis.popBatch(RK.viewQueue, t.flushBatch);
      } catch (_) {
        break; // Redis unavailable; retry next tick
      }
      if (!raw || raw.length === 0) break;

      try {
        await upsertSeenRows(aggregateViews(parseViewItems(raw)));
        flushFailures = 0;
        persisted += raw.length;
      } catch (err) {
        flushFailures += 1;
        log.error(`view flush failed (${flushFailures}/${t.maxFailures}): ${err.message}`);
        try {
          if (flushFailures >= t.maxFailures) {
            await redis.rpush(RK.viewDead, ...raw);
            await redis.ltrim(RK.viewDead, -10000, -1);
            log.error(`moved ${raw.length} view events to dead-letter list`);
            flushFailures = 0;
          } else {
            await redis.lpush(RK.viewQueue, ...raw.slice().reverse()); // restore original order at head
          }
        } catch (requeueErr) {
          log.error(`could not requeue ${raw.length} view events: ${requeueErr.message}`);
        }
        break;
      }
      if (raw.length < t.flushBatch) break;
    }
  } finally {
    flushing = false;
  }
  return persisted;
}

/* ----------------------- ranked catalog (engagement x freshness) ------------- */

const cvHas = (a) => Boolean(ChannelVideo.rawAttributes[a]);
const cvCol = (a) => `"${ChannelVideo.name}"."${ChannelVideo.rawAttributes[a].field || a}"`;
const cvNum = (a) => (cvHas(a) ? `COALESCE(${cvCol(a)}, 0)` : '0');

const cvPublished = cvHas('createdAt')
  ? `COALESCE(${cvCol('publishedAt')}, ${cvCol('createdAt')}, NOW())`
  : `COALESCE(${cvCol('publishedAt')}, NOW())`;
const AGE_HOURS_SQL = `GREATEST(EXTRACT(EPOCH FROM (NOW() - ${cvPublished})) / 3600.0, 0)`;
const ENGAGEMENT_SQL = `(LN((1 + ${cvNum('likesCount')} * ${Number(NF.ranking.wLike)} + ${cvNum('commentsCount')} * ${Number(NF.ranking.wComment)} + ${cvNum('viewCount')} * ${Number(NF.ranking.wView)})::float8) + 1.0)`;
const FRESHNESS_SQL = `(${Number(NF.ranking.floor)} + ${1 - Number(NF.ranking.floor)} * POWER(0.5::float8, (${AGE_HOURS_SQL})::float8 / ${Number(NF.ranking.halfLifeHours)}))`;
const SCORE_SQL = `(${ENGAGEMENT_SQL} * ${FRESHNESS_SQL})`;

const FEED_CHANNEL_ATTRS = [...CHANNEL_ATTRS, ...(Channel.rawAttributes.category ? ['category'] : [])];
const feedChannelInclude = () => [{ model: Channel, as: 'channel', attributes: FEED_CHANNEL_ATTRS, required: false }];

/** Atomic rebuild: ZADD into a temp key in keyset batches, then RENAME over the live key. Lock = one builder. */
async function rebuildCatalog() {
  const redis = getRedis();
  const c = NF.catalog;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const locked = await redis.set(RK.catalogLock, token, 'PX', c.lockTtlMs, 'NX');
  if (locked !== 'OK') return { skipped: true };

  const started = Date.now();
  const tmp = RK.catalogTmp(started);
  try {
    let lastId = null;
    let count = 0;
    while (count < c.maxSize) {
      const where = feedWhere(null);
      if (lastId !== null) where.id = { [Op.gt]: lastId };

      const rows = await ChannelVideo.findAll({
        where,
        attributes: ['id', [literal(SCORE_SQL), 'score']],
        order: [['id', 'ASC']],
        limit: c.batchSize,
        raw: true,
      });
      if (rows.length === 0) break;

      const args = [];
      for (const row of rows) args.push(Number(row.score) || 0, String(row.id));

      // Add Instagram reels to the catalog
      const igReels = await instagramService.getCatalogBatch({ limit: c.batchSize });
      for (const reel of igReels) args.push(Number(reel.score) || 0, String(reel.id));

      await redis.zadd(tmp, ...args);

      count += rows.length;
      lastId = rows[rows.length - 1].id;
      if (rows.length < c.batchSize) break;
    }

    if (count === 0) await redis.del(RK.catalog, tmp);
    else await redis.rename(tmp, RK.catalog);

    log.info(`catalog rebuilt: ${count} shorts in ${Date.now() - started}ms`);
    return { count, ms: Date.now() - started };
  } finally {
    await redis.del(tmp).catch(() => {});
    await redis.compareDel(RK.catalogLock, token).catch(() => {});
  }
}

/** Instant removal (admin delete/untoggle). The periodic rebuild also self-heals within ~60s. */
async function removeFromCatalog(ids) {
  if (!ids || ids.length === 0) return;
  ids.forEach((id) => hydrateCache.delete(String(id)));
  try {
    await getRedis().zrem(RK.catalog, ...ids.map(String));
  } catch (err) {
    log.warn(`removeFromCatalog failed: ${err.message}`);
  }
}

/* -------------------------------- hydration --------------------------------- */

const hydrateCache = new Map(); // id -> { v, exp }

function hydrateCacheSet(id, v) {
  if (hydrateCache.has(id)) hydrateCache.delete(id);
  else if (hydrateCache.size >= NF.catalog.hydrateMax) hydrateCache.delete(hydrateCache.keys().next().value);
  hydrateCache.set(id, { v, exp: Date.now() + NF.catalog.hydrateTtlMs });
}

/** Rows for ids (in-process TTL cache + one batched PK query), in the input (rank) order. */
async function hydrateVideos(ids) {
  const now = Date.now();
  const found = new Map();
  const miss = [];
  const igIds = [];

  for (const id of ids) {
    if (id.startsWith('ig_')) {
      igIds.push(id);
      continue;
    }
    const e = hydrateCache.get(id);
    if (e && e.exp > now) found.set(id, e.v);
    else miss.push(id);
  }

  let igReels = [];
  if (igIds.length > 0) {
    igReels = await instagramService.hydrateReels(igIds);
    for (const reel of igReels) {
      found.set(reel.id, reel);
    }
  }

  if (miss.length > 0) {
    const rows = await ChannelVideo.findAll({
      where: { ...feedWhere(null), id: { [Op.in]: miss } },
      attributes: { exclude: ['description'] },
      include: feedChannelInclude(),
      raw: true,
      nest: true,
    });
    for (const row of rows) {
      const id = String(row.id);
      found.set(id, row);
      hydrateCacheSet(id, row);
    }
  }

  const ordered = [];
  const missing = [];
  for (const id of ids) {
    if (found.has(id)) ordered.push(found.get(id));
    else missing.push(id);
  }
  return { rows: ordered, missing };
}

/* --------------------------------- diversity -------------------------------- */

const categoryOf = (row) => row.category || (row.channel && row.channel.category) || null;

/**
 * Rank-respecting diversity: never the same creator back-to-back (also vs. the previous page's last
 * item); within a small look-ahead, prefer a different category than the previous item.
 * Input must be best-first.
 */
function diversifyFeed(rows, limit, lastChannelId = null, lastCategory = null) {
  const remaining = rows.slice();
  const out = [];
  let lastC = lastChannelId == null ? null : String(lastChannelId);
  let lastCat = lastCategory || null;

  while (out.length < limit && remaining.length > 0) {
    let idx = -1;
    let firstOk = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      if (String(remaining[i].channelId) === lastC) continue;
      if (firstOk === -1) firstOk = i;
      const cat = categoryOf(remaining[i]);
      if (!cat || cat !== lastCat) {
        idx = i;
        break;
      }
      if (i - firstOk >= NF.categoryLookahead) break;
    }
    if (idx === -1) idx = firstOk;
    if (idx === -1) idx = 0; // only the same creator is left; unavoidable

    const [pick] = remaining.splice(idx, 1);
    out.push(pick);
    lastC = String(pick.channelId);
    lastCat = categoryOf(pick);
  }
  return out;
}

/* -------------------- PostgreSQL fallback (Redis unavailable) ---------------- */

/** ranked shorts WHERE id NOT IN (user's seen ids); if exhausted, cycles back to the top. */
// Degraded mode (Redis down): remember what we just served per viewer, in-process, so a refresh
// still moves forward through the ranking even before track-view data reaches PostgreSQL.
const fallbackServed = new Map(); // viewer.key -> { ids:Set<string>, exp:number }
const FALLBACK_MAX_VIEWERS = 20000;
const FALLBACK_MAX_IDS = 1000;

function getFallbackServed(viewer) {
  const e = fallbackServed.get(viewer.key);
  if (!e || e.exp <= Date.now()) {
    fallbackServed.delete(viewer.key);
    return new Set();
  }
  return e.ids;
}

function rememberFallbackServed(viewer, rows) {
  if (!rows.length) return;
  const ids = getFallbackServed(viewer);
  for (const r of rows) ids.add(String(r.id));
  while (ids.size > FALLBACK_MAX_IDS) ids.delete(ids.values().next().value); // drop oldest
  if (!fallbackServed.has(viewer.key) && fallbackServed.size >= FALLBACK_MAX_VIEWERS) {
    fallbackServed.delete(fallbackServed.keys().next().value);
  }
  fallbackServed.set(viewer.key, { ids, exp: Date.now() + NF.history.servedTtlSec * 1000 });
}

async function dbFallbackFeed(viewer, limit) {
  const seenTable = sequelize.getQueryInterface().queryGenerator.quoteTable(UserSeenVideo.getTableName());
  const servedIds = getFallbackServed(viewer);
  const pool = limit * NF.poolFactor + servedIds.size;

  const run = (excludeSeen) => {
    const where = feedWhere(null);
    if (excludeSeen && viewer.userId) {
      where.id = {
        [Op.notIn]: literal(
          `(SELECT "channelVideoId" FROM ${seenTable} WHERE "userId" = ${sequelize.escape(viewer.userId)})`
        ),
      };
    }
    return ChannelVideo.findAll({
      where,
      attributes: { exclude: ['description'] },
      include: feedChannelInclude(),
      order: [[literal(SCORE_SQL), 'DESC'], ['id', 'DESC']],
      limit: pool,
      subQuery: false,
      raw: true,
      nest: true,
    });
  };

  let rows = await run(true);
  if (servedIds.size > 0) rows = rows.filter((r) => !servedIds.has(String(r.id)));

  let cycled = false;
  if (rows.length === 0) {
    // Everything unseen/unserved is exhausted: cycle back to the top of the ranking.
    fallbackServed.delete(viewer.key);
    rows = await run(false);
    cycled = rows.length > 0;
  }
  return { rows, cycled };
}

/* ---------------------------------- workers --------------------------------- */

let feedWorkersStarted = false;
let catalogTimer = null;
let flushTimer = null;

/** Starts lazily on the first feed/track request; also exported for explicit boot-time start. */
function startFeedWorkers() {
  if (feedWorkersStarted) return;
  feedWorkersStarted = true;

  seenTableReady = UserSeenVideo.sync().catch((err) => log.error(`user_seen_videos sync failed: ${err.message}`));

  const catalogTick = async () => {
    try {
      await rebuildCatalog();
    } catch (err) {
      log.error(`catalog rebuild failed: ${err.message}`);
    }
    catalogTimer = setTimeout(catalogTick, NF.catalog.refreshMs);
    if (catalogTimer.unref) catalogTimer.unref();
  };
  catalogTick();

  const flushTick = async () => {
    try {
      await flushViewEvents();
    } catch (err) {
      log.error(`view flush loop error: ${err.message}`);
    }
    flushTimer = setTimeout(flushTick, NF.tracking.flushMs);
    if (flushTimer.unref) flushTimer.unref();
  };
  flushTimer = setTimeout(flushTick, NF.tracking.flushMs);
  if (flushTimer.unref) flushTimer.unref();

  log.info('feed workers started');
}

async function stopFeedWorkers() {
  if (!feedWorkersStarted) return;
  feedWorkersStarted = false;
  if (catalogTimer) clearTimeout(catalogTimer);
  if (flushTimer) clearTimeout(flushTimer);
  catalogTimer = null;
  flushTimer = null;
  try {
    await flushViewEvents(); // final drain so queued views reach PostgreSQL
  } catch (err) {
    log.error(`final view flush failed: ${err.message}`);
  }
  if (redisClient) {
    const c = redisClient;
    redisClient = null;
    try {
      await c.quit();
    } catch (_) {
      c.disconnect();
    }
  }
}

/* --------------------------------- endpoints -------------------------------- */

async function serveFeedFromRedis(viewer, limit) {
  const state = await getViewerState(viewer);
  if (viewer.userId && !state.loaded) await ensureHistoryLoaded(viewer);

  const poolSize = limit * NF.poolFactor;
  let rows = [];
  let reset = false;
  let catalogSize = 0;
  let pickMode = 'ranked';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let pick = await pickUnseen(viewer, poolSize);
    if (pick.mode === 'empty' && attempt === 0) {
      await rebuildCatalog(); // first request after a cold start
      pick = await pickUnseen(viewer, poolSize);
    }
    reset = reset || pick.reset;
    catalogSize = pick.catalogSize;
    pickMode = pick.mode;
    if (pick.ids.length === 0) break;

    const hydrated = await hydrateVideos(pick.ids);
    if (hydrated.missing.length > 0) await removeFromCatalog(hydrated.missing); // self-heal stale ids
    rows = hydrated.rows;
    if (rows.length > 0) break;
  }

  const ordered = diversifyFeed(rows, limit, state.last && state.last.c, state.last && state.last.k);
  const [data] = await Promise.all([attachLikes(ordered, viewer.userId), markServed(viewer, ordered)]);
  return { data, meta: { source: 'redis', catalogSize, cycleReset: reset, pickMode } };
}

async function serveFeedFromDb(viewer, limit) {
  const { rows, cycled } = await dbFallbackFeed(viewer, limit);
  const ordered = diversifyFeed(rows, limit);
  rememberFallbackServed(viewer, ordered);
  const data = await attachLikes(ordered, viewer.userId);
  return { data, meta: { source: 'postgres-fallback', cycleReset: cycled } };
}

/** GET /api/feed/shorts?limit=10 – ranked, creator-diverse, never repeats until the catalog is exhausted. */
exports.getFeed = asyncHandler(async (req, res) => {
  const started = process.hrtime.bigint();
  const viewer = resolveViewer(req);
  if (!viewer) return fail(res, 401, 'Authentication or X-Device-Id header is required.');

  const limit = clampInt(req.query.limit, FEED_DEFAULT_LIMIT, 1, 20);
  const cursor = req.query.cursor || null;
  const feedEngineService = require('../services/feedEngineService');
  const userId = viewer.userId || viewer.key;

  const result = await feedEngineService.getFeed(userId, cursor, limit);

  const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
  res.set('Cache-Control', 'private, no-store'); // personalised: never shared-cache
  res.set('Server-Timing', `feed;dur=${tookMs.toFixed(1)}`);
  res.status(200).json({
    success: true,
    count: result.data.length,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    data: result.data,
    meta: { tookMs: Math.round(tookMs) },
  });
});

/** Accepts { videoId } | { videoIds: [] } | { views|events: [{videoId, watchMs, completed}] } (object or JSON string). */
function parseTrackBody(rawBody) {
  let body = rawBody;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return [];
    }
  }
  if (!body || typeof body !== 'object') return [];

  const candidates = [];
  if (body.videoId !== undefined) candidates.push({ videoId: body.videoId, watchMs: body.watchMs, completed: body.completed });
  if (Array.isArray(body.videoIds)) body.videoIds.forEach((id) => candidates.push({ videoId: id }));
  const list = Array.isArray(body.views) ? body.views : Array.isArray(body.events) ? body.events : [];
  list.forEach((e) => {
    if (e && typeof e === 'object') candidates.push(e);
  });

  const events = [];
  const dedupe = new Set();
  for (const cand of candidates) {
    const videoId = normalizeId(cand.videoId);
    if (!videoId || dedupe.has(videoId)) continue;
    dedupe.add(videoId);
    events.push({
      videoId,
      watchMs: Math.min(Math.max(parseInt(cand.watchMs, 10) || 0, 0), NF.tracking.maxWatchMs),
      completed: cand.completed === true,
    });
    if (events.length >= NF.tracking.maxEvents) break;
  }
  return events;
}

/** POST /api/feed/track-view – instant Redis seen update, async batched PostgreSQL persistence. */
exports.trackView = asyncHandler(async (req, res) => {
  const viewer = resolveViewer(req);
  if (!viewer) return fail(res, 401, 'Authentication or X-Device-Id header is required.');

  const events = parseTrackBody(req.body);
  if (events.length === 0) {
    return fail(res, 400, 'Provide videoId, videoIds[] or views[{videoId, watchMs, completed}].');
  }

  startFeedWorkers();
  if (await isTrackRateLimited(viewer)) return fail(res, 429, 'Too many view events. Slow down.');

  let accepted = events;
  let seenCount = null;
  let degraded = false;

  try {
    const known = await filterKnownVideos(events.map((e) => e.videoId));
    accepted = events.filter((e) => known.has(e.videoId));
    if (accepted.length > 0) ({ seenCount } = await recordViews(viewer, accepted));
  } catch (err) {
    degraded = true; // Redis unavailable: buffer for direct PostgreSQL flush (authenticated users)
    log.error(`track-view degraded for ${viewer.key}: ${err.message}`);
    if (viewer.userId) bufferViewsLocally(viewer.userId, events);
  }

  res.status(202).json({
    success: true,
    accepted: degraded ? events.length : accepted.length,
    ignored: degraded ? 0 : events.length - accepted.length,
    seenCount,
    degraded,
  });
});

/** POST /api/shorts/seen – high-scale seen tracking for YouTube & Instagram */
exports.trackSeenBatch = asyncHandler(async (req, res) => {
  const viewer = resolveViewer(req);
  if (!viewer) return fail(res, 401, 'Authentication or X-Device-Id header is required.');

  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return fail(res, 400, 'events array is required.');
  }

  const feedEngineService = require('../services/feedEngineService');
  const userId = viewer.userId || viewer.key;
  const result = await feedEngineService.trackSeenBatch(userId, events);

  return res.status(202).json({
    success: true,
    accepted: result.accepted,
  });
});

exports.startFeedWorkers = startFeedWorkers;
exports.stopFeedWorkers = stopFeedWorkers;
exports.refreshFeedCatalog = rebuildCatalog;


/* -------------------------------------------------------------------------- */
/* Exposed for unit tests only                                                */
/* -------------------------------------------------------------------------- */

exports.__test = {
  interleaveByChannel,
  detectYouTubeInput,
  extractImportInput,
  encodeCursor,
  decodeCursor,
  isValidShortDuration,
  diversifyFeed,
  parseTrackBody,
  resolveViewer,
};