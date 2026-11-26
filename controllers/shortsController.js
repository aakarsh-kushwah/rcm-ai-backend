/**
 * shortsController.js  (Production-Hardened, Strict Short/Long Separation)
 */

const asyncHandler = require('express-async-handler');
const axios = require('axios');
const { Op, DataTypes, QueryTypes, literal } = require('sequelize');
const models = require('../models');
const { Channel, ChannelVideo, InstagramReel, ShortInteraction, ShortComment, User } = models;
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
const CURSOR_MAX_LENGTH = 400;

const CHANNEL_ATTRS = ['id', 'name', 'handle', 'logoUrl', 'youtubeChannelId'];
const USER_ATTRS = ['id', 'fullName', 'avatar'];

const POOL = {
  redisKey: 'shorts:feed:pool',
  redisStaleKey: 'shorts:feed:pool:stale',
  redisLockKey: 'shorts:feed:pool:lock',
  redisTtlSec: 15 * 60,
  staleTtlSec: 24 * 3600,
  softTtlMs: 10 * 60 * 1000,
  partialSoftTtlMs: 60 * 1000,
  hardStaleMs: 24 * 3600 * 1000,
  lockTtlMs: 30 * 1000,
  waitForPeerMs: 4000,
  retryBackoffMs: 15 * 1000,
  ytFetch: 1200,
  ytMax: 500,
  igFetch: 800,
  igMax: 500,
  perCreatorCap: 40,
  scanFactor: 3,
  maxScanChunks: 4,
  seenTimeoutMs: 250,
  historyWaitMs: 300,
  ytPerIg: 2,
};

const IG_STREAM = {
  ttlMs: 4 * 60 * 60 * 1000,
  maxAgeSec: 14400,
  expirySafetyMs: 5 * 60 * 1000,
  minUsableMs: 60 * 1000,
};
const IG_MEDIA_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const MOCK_SHORTCODE_RE = /^(?:[A-Za-z]\d){5}[A-Za-z]$/;
const MOCK_SHORTCODE_PREFIXES = ['C2m3n', 'C5f6', 'C5h6j'];
const isMockShortcode = (code) =>
  !code || MOCK_SHORTCODE_RE.test(code) || MOCK_SHORTCODE_PREFIXES.some((p) => String(code).startsWith(p));

const SEEN_QUEUE = {
  maxEventsPerBatch: 50,
  queueMax: 5000,
  concurrency: 4,
};

/* -------------------------------------------------------------------------- */
/* Logging & errors                                                           */
/* -------------------------------------------------------------------------- */

const stamp = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(stamp(), '[shorts]', ...a),
  warn: (...a) => console.warn(stamp(), '[shorts]', ...a),
  error: (...a) => console.error(stamp(), '[shorts]', ...a),
};

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/* -------------------------------------------------------------------------- */
/* Short-form business rule (single source of truth)                          */
/* -------------------------------------------------------------------------- */

const isValidShortDuration = (seconds) =>
  Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SHORT_SECONDS;

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
let generation = 0;

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
    if (store.has(key)) store.delete(key);
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
    refresh(key, ttl, loader).catch((err) => log.error(`cache refresh failed for ${key}: ${err.message}`));
    return e.v;
  }
  return refresh(key, ttl, loader);
}

const invalidateFeedCache = () => {
  cache.clear();
  invalidateCandidatePool();
};

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* -------------------------------------------------------------------------- */

function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function normalizeId(raw) {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function firstPresent(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function creatorKeyOf(row) {
  if (!row) return null;
  const ch = row.channel && typeof row.channel === 'object' ? row.channel : {};
  const raw = firstPresent(
    row.channelId,
    row.accountId,
    row.creatorHandle,
    row.username,
    row.ownerUsername,
    ch.id,
    ch.handle
  );
  return raw === undefined ? null : String(raw);
}

const platformOf = (row) => (String(row.id).startsWith('ig_') ? 'ig' : 'yt');
const poolCreatorKey = (row) => `${platformOf(row)}:${creatorKeyOf(row) || '_'}`;

function safeRequire(path) {
  try {
    return require(path);
  } catch (_) {
    return null;
  }
}

const existingAttrs = (Model, names) =>
  Model && Model.rawAttributes ? names.filter((n) => Boolean(Model.rawAttributes[n])) : [];

/* -------------------------------------------------------------------------- */
/* Cursor helpers                                                             */
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

function encodePoolCursor({ v, o, a }) {
  return Buffer.from(JSON.stringify({ k: 'p', v, o, a })).toString('base64url');
}

function decodePoolCursor(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > CURSOR_MAX_LENGTH) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!obj || obj.k !== 'p' || !Number.isInteger(obj.o) || obj.o < 0) return null;
    return { v: String(obj.v || ''), o: obj.o, a: obj.a == null ? null : String(obj.a) };
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
/* Per-channel feed (channel pages)                                           */
/* -------------------------------------------------------------------------- */

const feedWhere = (channelId) => {
  const where = shortScope({ isAvailable: true });
  if (channelId) where.channelId = channelId;
  return where;
};

async function attachLikes(rows, userId) {
  const liked = new Set();
  if (userId && rows.length > 0) {
    const ytIds = rows.filter((r) => !String(r.id).startsWith('ig_')).map((r) => r.id);
    const igIds = rows.filter((r) => String(r.id).startsWith('ig_')).map((r) => r.id);

    if (ytIds.length > 0) {
      try {
        const interactions = await ShortInteraction.findAll({
          where: { userId, channelVideoId: { [Op.in]: ytIds }, type: 'like' },
          attributes: ['channelVideoId'],
          raw: true,
        });
        interactions.forEach((i) => liked.add(i.channelVideoId));
      } catch (err) {
        log.warn(`youtube like lookup failed: ${err.message}`);
      }
    }

    if (igIds.length > 0) {
      try {
        const igLikes = await instagramService.getLikedSet(userId, igIds);
        igLikes.forEach((id) => liked.add(id));
      } catch (err) {
        log.warn(`instagram like lookup failed: ${err.message}`);
      }
    }
  }
  return rows.map((r) => ({
    ...r,
    isLiked: liked.has(r.id),
    videoUrl: r.youtubeVideoId ? `https://www.youtube.com/watch?v=${r.youtubeVideoId}` : r.videoUrl,
  }));
}

function interleaveByChannel(rows, limit = Infinity, avoidFirstChannelId = null, keyFn = (row) => String(row.channelId)) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const queues = new Map();
  for (const row of rows) {
    const cid = keyFn(row);
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
    limit: limit + 1,
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

/* -------------------------------------------------------------------------- */
/* Instagram stream engine: GET /api/shorts/ig-stream/:shortcode              */
/* -------------------------------------------------------------------------- */

function setStreamCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

function evaluateMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return null;
  if (!IG_MEDIA_HOST_RE.test(host) && !/\.mp4$/i.test(u.pathname)) return null;

  let ttlMs = IG_STREAM.ttlMs;
  const oe = u.searchParams.get('oe');
  if (oe && /^[0-9a-f]{6,10}$/i.test(oe)) {
    const expiresAt = parseInt(oe, 16) * 1000;
    if (Number.isFinite(expiresAt)) ttlMs = Math.min(ttlMs, expiresAt - Date.now() - IG_STREAM.expirySafetyMs);
  }
  if (ttlMs < IG_STREAM.minUsableMs) return null;
  return { url: u.href, ttlMs };
}

function getInstagramAccountModel() {
  return models.InstagramAccount || safeRequire('../models/InstagramAccount');
}

function redirectToMedia(res, url, ttlMs) {
  const maxAge = Math.max(0, Math.min(IG_STREAM.maxAgeSec, Math.floor(ttlMs / 1000)));
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
  res.end();
}

function streamUnavailable(res) {
  res.setHeader('Cache-Control', 'public, max-age=10');
  return res.status(404).json({ error: 'Stream unavailable' });
}

exports.getInstagramStream = async (req, res) => {
  setStreamCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const shortcode = req.params.shortcode;
  if (!shortcode || !SHORTCODE_RE.test(shortcode) || isMockShortcode(shortcode)) {
    return streamUnavailable(res);
  }

  try {
    const reel = await InstagramReel.findOne({
      where: { shortcode },
      attributes: ['videoUrl'],
      raw: true,
    });
    const media = evaluateMediaUrl(reel && reel.videoUrl);
    if (!media) return streamUnavailable(res);
    return redirectToMedia(res, media.url, media.ttlMs);
  } catch (err) {
    log.error(`ig-stream database lookup failed for ${shortcode}: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to load Instagram Reel stream.' });
  }
};

exports.reportUnavailable = asyncHandler(async (req, res) => {
  const id = String((req.params && req.params.id) || '');
  if (id.startsWith('ig_')) {
    const shortcode = id.slice(3);
    if (SHORTCODE_RE.test(shortcode)) {
      await InstagramReel.update({ videoUrl: null }, { where: { shortcode } });
    }
  }
  return res.status(200).json({ success: true });
});

/* -------------------------------------------------------------------------- */
/* Likes & comments                                                           */
/* -------------------------------------------------------------------------- */

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

  const { isLiked, likesCount } = await ChannelVideo.sequelize.transaction(async (transaction) => {
    const removed = await ShortInteraction.destroy({
      where: { userId, channelVideoId: videoId, type: 'like' },
      transaction,
    });

    let liked;
    if (removed > 0) {
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

  const { promoted, demoted, shortsCount } = await ChannelVideo.sequelize.transaction(async (transaction) => {
    channel.isShortsOnly = !channel.isShortsOnly;
    if (Channel.rawAttributes.source) {
      channel.source = channel.isShortsOnly ? 'shorts-only' : 'channel';
    }
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

exports.adminImportSingleShort = asyncHandler(async (req, res) => {
  const input = String((req.body && (req.body.videoUrl || req.body.url)) || '').trim();
  if (!input) return fail(res, 400, 'A YouTube Short or channel URL is required.');

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      success: false,
      message: 'YouTube channel resolution is unavailable; configure YOUTUBE_API_KEY.',
    });
  }

  const videoMatch = input.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:shorts|embed|live|v)\/|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[/?#]|$)/i
  );
  const isVideoImport = Boolean(videoMatch);
  const channelIdMatch = input.match(/^(UC[\w-]{22})$/);
  let handle = null;
  let channelId = channelIdMatch ? channelIdMatch[1] : null;
  let isShortsOnly = Boolean(req.body && req.body.shortsOnly === true);

  if (!videoMatch && !channelId) {
    if (input.startsWith('@')) {
      handle = input.slice(1);
    } else {
      try {
        const url = new URL(input);
        if (!/(^|\.)youtube\.com$/i.test(url.hostname)) {
          return fail(res, 400, 'Provide a valid YouTube Short or channel URL.');
        }
        const path = url.pathname;
        const channelPath = path.match(/^\/channel\/(UC[\w-]{22})\/?$/i);
        const handlePath = path.match(/^\/@([\w.-]{1,100})(?:\/.*)?$/);
        const customPath = path.match(/^\/(?:c|user)\/([\w.-]{1,100})(?:\/.*)?$/i);
        if (channelPath) channelId = channelPath[1];
        else if (handlePath) handle = handlePath[1];
        else if (customPath) handle = customPath[1];
        else return fail(res, 400, 'Provide a valid YouTube Short or channel URL.');
      } catch (_) {
        return fail(res, 400, 'Provide a valid YouTube Short or channel URL.');
      }
    }
  }

  try {
    if (videoMatch) {
      const { data } = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'snippet', id: videoMatch[1], key: apiKey },
        timeout: 10000,
      });
      const video = (data.items || [])[0];
      if (!video || !video.snippet || !video.snippet.channelId) {
        return res.status(404).json({ success: false, message: 'YouTube video was not found.' });
      }
      channelId = video.snippet.channelId;
    } else if (!channelId) {
      const { data } = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
        params: { part: 'id', forHandle: handle, key: apiKey },
        timeout: 10000,
      });
      const matchedChannel = (data.items || [])[0];
      if (matchedChannel) channelId = matchedChannel.id;
      else {
        const search = await axios.get('https://www.googleapis.com/youtube/v3/search', {
          params: { part: 'snippet', type: 'channel', q: handle, maxResults: 1, key: apiKey },
          timeout: 10000,
        });
        channelId = ((search.data.items || [])[0] || {}).id?.channelId;
      }
    }

    if (!channelId) return res.status(404).json({ success: false, message: 'YouTube channel was not found.' });

    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: {
        part: 'snippet,contentDetails,statistics,brandingSettings',
        id: channelId,
        key: apiKey,
      },
      timeout: 10000,
    });
    const details = (data.items || [])[0];
    const snippet = (details && details.snippet) || {};
    const uploadsPlaylistId =
      details && details.contentDetails && details.contentDetails.relatedPlaylists
        ? details.contentDetails.relatedPlaylists.uploads
        : null;
    if (!details || !uploadsPlaylistId) {
      return res.status(404).json({ success: false, message: 'YouTube channel details were not found.' });
    }

    const statistics = details.statistics || {};
    const branding = details.brandingSettings || {};
    const thumbnails = snippet.thumbnails || {};
    const existing = await Channel.findOne({ where: { youtubeChannelId: details.id } });
    const values = {
      youtubeChannelId: details.id,
      handle: snippet.customUrl || (handle ? `@${handle}` : ''),
      name: snippet.title || 'Unknown Channel',
      logoUrl:
        (thumbnails.high && thumbnails.high.url) ||
        (thumbnails.medium && thumbnails.medium.url) ||
        (thumbnails.default && thumbnails.default.url) ||
        '',
      bannerUrl: (branding.image && branding.image.bannerExternalUrl) || '',
      description: snippet.description || '',
      subscriberCount: Number(statistics.subscriberCount) || 0,
      videoCount: Number(statistics.videoCount) || 0,
      viewCount: Number(statistics.viewCount) || 0,
      joinedDate: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
      country: snippet.country || null,
      uploadsPlaylistId,
      lastSyncStatus: 'pending',
      lastSyncError: null,
    };

    let channel;
    if (existing) {
      if (isShortsOnly) {
        values.source = 'shorts-only';
        values.isShortsOnly = true;
      }
      await existing.update(values);
      channel = existing;
    } else {
      channel = await Channel.create({
        ...values,
        isActive: true,
        source: isShortsOnly || isVideoImport ? 'shorts-only' : 'channel',
        isShortsOnly: isShortsOnly || isVideoImport,
      });
    }

    return res.status(existing ? 200 : 201).json({
      success: true,
      message: 'Channel sync requested; the local worker will process it on its next run.',
      count: 0,
      newVideosCount: 0,
      data: { channel, newShortsCount: 0 },
      worker: 'local',
    });
  } catch (err) {
    log.error(`Shorts import channel resolution failed: ${err.message}`);
    return res.status(502).json({
      success: false,
      message: 'Failed to resolve the YouTube channel for worker sync.',
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Feed engine configuration                                                  */
/* -------------------------------------------------------------------------- */

const NF = {
  poolFactor: 4,
  categoryLookahead: 6,
  ranking: { wLike: 3, wComment: 5, wView: 0.02, halfLifeHours: 72, floor: 0.15 },
  catalog: { refreshMs: 60 * 1000, batchSize: 5000, maxSize: 200000, lockTtlMs: 120 * 1000 },
  history: {
    keepRatio: Number(process.env.FEED_RESET_KEEP_RATIO) || 0.2,
    maxEntries: 50000,
    ttlSec: 90 * 24 * 3600,
    anonTtlSec: 7 * 24 * 3600,
    servedTtlSec: 30 * 60,
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
  catalog: `${RP}catalog`,
  catalogLock: `${RP}catalog:lock`,
  catalogTmp: (t) => `${RP}catalog:tmp:${t}`,
  seen: (v) => `${RP}seen:${v}`,
  loaded: (v) => `${RP}loaded:${v}`,
  rate: (v) => `${RP}rate:${v}`,
  viewQueue: `${RP}viewqueue`,
  viewDead: `${RP}viewqueue:dead`,
};

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

const isPersistableVideoId = (id) => /^\d+$/.test(String(id));

const seenCol = (attr) =>
  sequelize.getQueryInterface().queryGenerator.quoteIdentifier(UserSeenVideo.rawAttributes[attr].field || attr);

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

let { connection: redisClient } = require('../config/redis');
let redisCustomCommandsRegistered = false;

function getRedis() {
  if (!redisClient) return null;
  if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
    return null;
  }
  if (!redisCustomCommandsRegistered) {
    try {
      redisClient.defineCommand('popBatch', { numberOfKeys: 1, lua: POP_BATCH_LUA });
      redisClient.defineCommand('compareDel', { numberOfKeys: 1, lua: COMPARE_DEL_LUA });
      redisCustomCommandsRegistered = true;
    } catch (_) {}
  }
  return redisClient;
}

function safeRedis() {
  try {
    const client = getRedis();
    if (!client || (client.status !== 'ready' && client.status !== 'connecting')) {
      return null;
    }
    return client;
  } catch (_) {
    return null;
  }
}

function assertPipeline(results) {
  if (!results) throw new Error('redis pipeline returned no results');
  for (const [err] of results) if (err) throw err;
  return results;
}

function resolveViewer(req) {
  if (req.user && req.user.id != null) return { key: `u:${req.user.id}`, userId: req.user.id };
  const device = req.headers['x-device-id'];
  if (typeof device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(device)) return { key: `d:${device}`, userId: null };
  return null;
}

const viewerTtl = (viewer) => (viewer.userId ? NF.history.ttlSec : NF.history.anonTtlSec);

const historyLoading = new Map();

function ensureHistoryLoaded(viewer) {
  if (!viewer.userId) return Promise.resolve();
  if (historyLoading.has(viewer.key)) return historyLoading.get(viewer.key);
  const p = loadHistoryFromDb(viewer).finally(() => historyLoading.delete(viewer.key));
  historyLoading.set(viewer.key, p);
  return p;
}

async function loadHistoryFromDb(viewer) {
  const redis = safeRedis();
  if (!redis) return;
  try {
    await seenTableReady;
    const rows = await UserSeenVideo.findAll({
      where: { userId: viewer.userId },
      attributes: ['channelVideoId', 'lastSeenAt'],
      order: [['lastSeenAt', 'DESC']],
      limit: NF.history.maxEntries,
      raw: true,
    });

    const seenKey = RK.seen(viewer.key);
    for (let i = 0; i < rows.length; i += 1000) {
      const args = [];
      for (const r of rows.slice(i, i + 1000)) args.push(new Date(r.lastSeenAt).getTime(), String(r.channelVideoId));
      assertPipeline(await redis.pipeline().zadd(seenKey, 'NX', ...args).exec());
    }

    const pipe = redis.pipeline();
    if (rows.length > 0) pipe.expire(seenKey, viewerTtl(viewer));
    pipe.set(RK.loaded(viewer.key), '1', 'EX', viewerTtl(viewer));
    assertPipeline(await pipe.exec());
    if (rows.length > 0) log.info(`restored ${rows.length} seen ids for ${viewer.key} from the database`);
  } catch (err) {
    try {
      await redis.set(RK.loaded(viewer.key), '1', 'EX', 60);
    } catch (_) {}
    throw err;
  }
}

async function getSeenSet(viewer, ids) {
  const seen = new Set();
  if (!viewer || ids.length === 0) return seen;
  const redis = safeRedis();
  if (!redis) return seen;

  const run = async () => {
    const pipe = redis.pipeline();
    pipe.get(RK.loaded(viewer.key));
    ids.forEach((id) => pipe.zscore(RK.seen(viewer.key), id));
    return assertPipeline(await withTimeout(pipe.exec(), POOL.seenTimeoutMs, 'seen lookup'));
  };

  try {
    let results = await run();
    if (viewer.userId && results[0][1] !== '1') {
      await Promise.race([ensureHistoryLoaded(viewer).catch(() => {}), sleep(POOL.historyWaitMs)]);
      results = await run();
    }
    ids.forEach((id, i) => {
      const score = results[i + 1][1];
      if (score !== null && score !== undefined) seen.add(id);
    });
  } catch (err) {
    log.warn(`seen lookup skipped for ${viewer.key}: ${err.message}`);
  }
  return seen;
}

async function recordSeenIds(viewer, ids) {
  if (!viewer || ids.length === 0) return;
  const redis = safeRedis();
  if (!redis) return;
  const now = Date.now();
  const seenKey = RK.seen(viewer.key);
  const zargs = [];
  ids.forEach((id, i) => zargs.push(now + i, id));

  const pipe = redis.pipeline();
  pipe.zadd(seenKey, ...zargs);
  pipe.expire(seenKey, viewerTtl(viewer));
  pipe.zremrangebyrank(seenKey, 0, -(NF.history.maxEntries + 1));
  assertPipeline(await pipe.exec());
}

async function trimSeenHistory(viewer, poolSize) {
  const redis = safeRedis();
  if (!redis || !viewer) return;
  const keep = Math.max(0, Math.floor(poolSize * NF.history.keepRatio));
  try {
    await redis.zremrangebyrank(RK.seen(viewer.key), 0, -(keep + 1));
  } catch (err) {
    log.warn(`trimSeenHistory failed for ${viewer.key}: ${err.message}`);
  }
}

async function filterKnownVideos(ids) {
  const known = new Set();
  const redis = safeRedis();
  if (!redis || !ids || ids.length === 0) return known;
  try {
    const pipe = redis.pipeline();
    ids.forEach((id) => pipe.zscore(RK.catalog, id));
    const results = assertPipeline(await pipe.exec());
    results.forEach(([, score], i) => {
      if (score !== null && score !== undefined) known.add(ids[i]);
    });
  } catch (err) {
    log.warn(`filterKnownVideos failed: ${err.message}`);
  }
  return known;
}

async function recordViews(viewer, events) {
  const redis = safeRedis();
  if (!redis || !viewer || !events || events.length === 0) return { seenCount: 0 };
  try {
    const now = Date.now();
    const seenKey = RK.seen(viewer.key);
    const zargs = [];
    events.forEach((e, i) => zargs.push(now + i, e.videoId));

    const pipe = redis.pipeline();
    pipe.zadd(seenKey, ...zargs);
    pipe.expire(seenKey, viewerTtl(viewer));
    pipe.zremrangebyrank(seenKey, 0, -(NF.history.maxEntries + 1));
    pipe.zcard(seenKey);
    if (viewer.userId) {
      const persistable = events.filter((e) => isPersistableVideoId(e.videoId));
      if (persistable.length > 0) enqueueViews(pipe, viewer.userId, persistable, now);
    }

    const results = assertPipeline(await pipe.exec());
    return { seenCount: Number(results[3][1]) || 0 };
  } catch (err) {
    log.warn(`recordViews failed: ${err.message}`);
    return { seenCount: 0 };
  }
}

async function isTrackRateLimited(viewer) {
  const redis = safeRedis();
  if (!redis || !viewer) return false;
  try {
    const key = RK.rate(viewer.key);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60);
    return n > NF.tracking.ratePerMin;
  } catch (_) {
    return false;
  }
}

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
  pipe.ltrim(RK.viewQueue, -NF.tracking.queueMax, -1);
}

function bufferViewsLocally(userId, events) {
  const ts = Date.now();
  for (const e of events) {
    if (!isPersistableVideoId(e.videoId)) continue;
    if (localViewBuffer.length >= NF.tracking.localBufferMax) localViewBuffer.shift();
    localViewBuffer.push(toViewEvent(userId, e, ts));
  }
}

function parseViewItems(raw) {
  const out = [];
  for (const s of raw) {
    try {
      const o = JSON.parse(s);
      if (o && o.u != null && o.v && Number.isFinite(o.t) && isPersistableVideoId(o.v)) out.push(o);
    } catch (_) {}
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
  const qg = sequelize.getQueryInterface().queryGenerator;
  const table = qg.quoteTable(UserSeenVideo.getTableName());
  const isPg = sequelize.getDialect() === 'postgres';
  const c = {
    user: seenCol('userId'),
    video: seenCol('channelVideoId'),
    first: seenCol('firstSeenAt'),
    last: seenCol('lastSeenAt'),
    count: seenCol('viewCount'),
    watch: seenCol('watchMs'),
    done: seenCol('completed'),
    created: qg.quoteIdentifier(UserSeenVideo.rawAttributes.createdAt.field || 'createdAt'),
    updated: qg.quoteIdentifier(UserSeenVideo.rawAttributes.updatedAt.field || 'updatedAt'),
  };
  const columns = [c.user, c.video, c.first, c.last, c.count, c.watch, c.done, c.created, c.updated].join(',');
  const now = new Date();

  const onConflict = isPg
    ? `ON CONFLICT (${c.user},${c.video}) DO UPDATE SET
         ${c.first} = LEAST(${table}.${c.first}, EXCLUDED.${c.first}),
         ${c.last}  = GREATEST(${table}.${c.last}, EXCLUDED.${c.last}),
         ${c.count} = ${table}.${c.count} + EXCLUDED.${c.count},
         ${c.watch} = ${table}.${c.watch} + EXCLUDED.${c.watch},
         ${c.done}  = ${table}.${c.done} OR EXCLUDED.${c.done},
         ${c.updated} = EXCLUDED.${c.updated}`
    : `ON DUPLICATE KEY UPDATE
         ${c.first} = LEAST(${c.first}, VALUES(${c.first})),
         ${c.last}  = GREATEST(${c.last}, VALUES(${c.last})),
         ${c.count} = ${c.count} + VALUES(${c.count}),
         ${c.watch} = ${c.watch} + VALUES(${c.watch}),
         ${c.done}  = (${c.done} OR VALUES(${c.done})),
         ${c.updated} = VALUES(${c.updated})`;

  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    const replacements = [];
    for (const r of chunk) {
      replacements.push(r.userId, r.videoId, new Date(r.first), new Date(r.last), r.count, r.watch, r.done, now, now);
    }
    await sequelize.query(`INSERT INTO ${table} (${columns}) VALUES ${placeholders} ${onConflict}`, {
      replacements,
      type: QueryTypes.INSERT,
    });
  }
}

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
    if (!redis) return persisted;
    for (let n = 0; n < t.maxBatchesPerTick; n += 1) {
      let raw;
      try {
        raw = await redis.popBatch(RK.viewQueue, t.flushBatch);
      } catch (_) {
        break;
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
            await redis.lpush(RK.viewQueue, ...raw.slice().reverse());
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

const cvHas = (a) => Boolean(ChannelVideo.rawAttributes[a]);
const cvCol = (a) => `\`${ChannelVideo.name}\`.\`${ChannelVideo.rawAttributes[a].field || a}\``;
const cvNum = (a) => (cvHas(a) ? `COALESCE(${cvCol(a)}, 0)` : '0');

const cvPublished = cvHas('createdAt')
  ? `COALESCE(\`ChannelVideo\`.\`published_at\`, \`ChannelVideo\`.\`created_at\`, NOW())`
  : `COALESCE(\`ChannelVideo\`.\`published_at\`, NOW())`;
const AGE_HOURS_SQL = `GREATEST(TIMESTAMPDIFF(SECOND, ${cvPublished}, NOW()) / 3600.0, 0)`;
const ENGAGEMENT_SQL = `(LN(1 + ${cvNum('likesCount')} * ${Number(NF.ranking.wLike)} + ${cvNum('commentsCount')} * ${Number(NF.ranking.wComment)} + ${cvNum('viewCount')} * ${Number(NF.ranking.wView)}) + 1.0)`;
const FRESHNESS_SQL = `(${Number(NF.ranking.floor)} + ${1 - Number(NF.ranking.floor)} * POW(0.5, (${AGE_HOURS_SQL}) / ${Number(NF.ranking.halfLifeHours)}))`;
const SCORE_SQL = `(${ENGAGEMENT_SQL} * ${FRESHNESS_SQL})`;

const FEED_CHANNEL_ATTRS = [...CHANNEL_ATTRS, ...(Channel.rawAttributes.category ? ['category'] : [])];
const feedChannelInclude = () => [{ model: Channel, as: 'channel', attributes: FEED_CHANNEL_ATTRS, required: false }];

async function rebuildCatalog() {
  const redis = getRedis();
  if (!redis) return { skipped: true };
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
      await redis.zadd(tmp, ...args);

      count += rows.length;
      lastId = rows[rows.length - 1].id;
      if (rows.length < c.batchSize) break;
    }

    try {
      const igReels = await instagramService.getCatalogBatch({ limit: c.batchSize });
      if (Array.isArray(igReels) && igReels.length > 0) {
        const args = [];
        for (const reel of igReels) args.push(Number(reel.score) || 0, String(reel.id));
        await redis.zadd(tmp, ...args);
        count += igReels.length;
      }
    } catch (igErr) {
      log.warn(`catalog: instagram batch skipped: ${igErr.message}`);
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

async function removeFromCatalog(ids) {
  if (!ids || ids.length === 0) return;
  evictFromPool(ids);
  const redis = safeRedis();
  if (!redis) return;
  try {
    await redis.zrem(RK.catalog, ...ids.map(String));
  } catch (err) {
    log.warn(`removeFromCatalog failed: ${err.message}`);
  }
}

const categoryOf = (row) => row.category || (row.channel && row.channel.category) || null;

function diversifyFeed(rows, limit, lastChannelId = null, lastCategory = null) {
  const remaining = rows.slice();
  const out = [];
  let lastC = lastChannelId == null ? null : String(lastChannelId);
  let lastCat = lastCategory || null;

  while (out.length < limit && remaining.length > 0) {
    let idx = -1;
    let firstOk = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      const key = creatorKeyOf(remaining[i]);
      if (key !== null && key === lastC) continue;
      if (firstOk === -1) firstOk = i;
      const cat = categoryOf(remaining[i]);
      if (!cat || cat !== lastCat) {
        idx = i;
        break;
      }
      if (i - firstOk >= NF.categoryLookahead) break;
    }
    if (idx === -1) idx = firstOk;
    if (idx === -1) idx = 0;

    const [pick] = remaining.splice(idx, 1);
    out.push(pick);
    lastC = creatorKeyOf(pick);
    lastCat = categoryOf(pick);
  }
  return out;
}

let poolL1 = null;
let poolInflight = null;
let poolRetryAt = 0;
let poolDirty = false;

function setPool(payload) {
  const index = new Map();
  payload.rows.forEach((row, i) => index.set(String(row.id), i));
  poolL1 = {
    version: String(payload.version),
    builtAt: Number(payload.builtAt) || Date.now(),
    partial: Boolean(payload.partial),
    rows: payload.rows,
    index,
  };
  poolDirty = false;
  return poolL1;
}

const IG_VIDEO_KEYS = [
  'videoUrl',
  'directVideo',
  'direct_video',
  'directVideoUrl',
  'direct_video_url',
  'video_url',
  'mediaUrl',
  'media_url',
  'playbackUrl',
  'playback_url',
];

function toClientInstagramRow(row) {
  const out = { ...row };
  const derivedCode = String(out.id).replace(/^ig_/, '');
  const shortcode = String(out.shortcode || (SHORTCODE_RE.test(derivedCode) ? derivedCode : '') || '');
  if (shortcode) out.shortcode = shortcode;

  IG_VIDEO_KEYS.forEach((key) => {
    delete out[key];
  });
  return out;
}

async function loadYoutubeCandidates() {
  const rows = await ChannelVideo.findAll({
    where: feedWhere(null),
    attributes: { exclude: ['description'], include: [[literal(SCORE_SQL), 'score']] },
    include: feedChannelInclude(),
    order: [[literal(SCORE_SQL), 'DESC'], ['id', 'DESC']],
    limit: POOL.ytFetch,
    subQuery: false,
    raw: true,
    nest: true,
  });

  const scores = new Map();
  const perCreator = new Map();
  const out = [];
  for (const row of rows) {
    const key = String(row.channelId);
    const used = perCreator.get(key) || 0;
    if (used >= POOL.perCreatorCap) continue;
    perCreator.set(key, used + 1);
    scores.set(String(row.id), Number(row.score) || 0);
    delete row.score;
    out.push(row);
    if (out.length >= POOL.ytMax) break;
  }
  return { rows: out, scores };
}

function instagramScore({ likes, comments, views, publishedAt }) {
  const { wLike, wComment, wView, halfLifeHours, floor } = NF.ranking;
  const engagement = Math.log(1 + likes * wLike + comments * wComment + views * wView) + 1.0;
  const t = publishedAt ? new Date(publishedAt).getTime() : NaN;
  const ageHours = Number.isFinite(t) ? Math.max((Date.now() - t) / 3600000, 0) : halfLifeHours;
  return engagement * (floor + (1 - floor) * Math.pow(0.5, ageHours / halfLifeHours));
}

async function loadInstagramCandidates() {
  const Reel = getInstagramReelModel();
  const Account = getInstagramAccountModel();
  if (!Reel || !Reel.rawAttributes || !Reel.rawAttributes.videoUrl || !Reel.rawAttributes.shortcode) {
    return { rows: [], scores: new Map() };
  }

  const reelAttrs = existingAttrs(Reel, [
    'id',
    'shortcode',
    'videoUrl',
    'accountId',
    'ownerUsername',
    'username',
    'caption',
    'description',
    'thumbnailUrl',
    'displayUrl',
    'thumbnail',
    'likesCount',
    'commentsCount',
    'playCount',
    'viewCount',
    'videoPlayCount',
    'takenAt',
    'publishedAt',
    'createdAt',
  ]);
  const where = { videoUrl: { [Op.like]: 'https://%' } };
  if (Reel.rawAttributes.isAvailable) where.isAvailable = true;
  if (Reel.rawAttributes.isActive) where.isActive = true;
  if (Reel.rawAttributes.isMock) where.isMock = false;

  const orderAttr = ['takenAt', 'publishedAt', 'createdAt', 'id'].find((a) => Reel.rawAttributes[a]);
  const reels = await Reel.findAll({
    where,
    attributes: reelAttrs,
    order: [[orderAttr, 'DESC']],
    limit: POOL.igFetch * 2,
    raw: true,
  });

  const accountIds = new Set();
  const usernames = new Set();
  reels.forEach((r) => {
    if (r.accountId != null) accountIds.add(r.accountId);
    const u = firstPresent(r.ownerUsername, r.username);
    if (u) usernames.add(String(u).replace(/^@+/, '').toLowerCase());
  });

  const byId = new Map();
  const byUsername = new Map();
  if (Account && Account.rawAttributes && (accountIds.size > 0 || usernames.size > 0)) {
    try {
      const accAttrs = existingAttrs(Account, [
        'id',
        'username',
        'fullName',
        'profilePicUrl',
        'verified',
        'isVerified',
        'followersCount',
        'isActive',
      ]);
      const ors = [];
      if (accountIds.size > 0 && Account.rawAttributes.id) ors.push({ id: { [Op.in]: Array.from(accountIds) } });
      if (usernames.size > 0 && Account.rawAttributes.username) ors.push({ username: { [Op.in]: Array.from(usernames) } });
      if (ors.length > 0) {
        const accounts = await Account.findAll({ where: { [Op.or]: ors }, attributes: accAttrs, raw: true });
        accounts.forEach((a) => {
          if (a.id != null) byId.set(String(a.id), a);
          if (a.username) byUsername.set(String(a.username).replace(/^@+/, '').toLowerCase(), a);
        });
      }
    } catch (err) {
      log.warn(`instagram account join failed: ${err.message}`);
    }
  }

  const scored = [];
  for (const r of reels) {
    const shortcode = String(r.shortcode || '');
    if (!SHORTCODE_RE.test(shortcode) || isMockShortcode(shortcode)) continue;
    if (!evaluateMediaUrl(r.videoUrl)) continue;

    const ownerName = String(firstPresent(r.ownerUsername, r.username) || '').replace(/^@+/, '');
    const account =
      (r.accountId != null && byId.get(String(r.accountId))) || (ownerName && byUsername.get(ownerName.toLowerCase())) || null;
    if (account && account.isActive === false) continue;

    const username = String((account && account.username) || ownerName || '').replace(/^@+/, '');
    if (!username) continue;

    const fullName = (account && account.fullName) || username;
    const caption = String(firstPresent(r.caption, r.description) || '').trim();
    const likes = Number(r.likesCount) || 0;
    const comments = Number(r.commentsCount) || 0;
    const views = Number(firstPresent(r.playCount, r.videoPlayCount, r.viewCount) || 0) || 0;
    const publishedAt = firstPresent(r.takenAt, r.publishedAt, r.createdAt) || null;
    const verified = Boolean(account && (account.verified || account.isVerified));
    const profilePicUrl = (account && account.profilePicUrl) || '';

    const row = {
      id: `ig_${shortcode}`,
      platform: 'instagram',
      shortcode,
      videoUrl: r.videoUrl,
      accountId: account ? account.id : r.accountId != null ? r.accountId : null,
      username,
      ownerUsername: username,
      fullName,
      profilePicUrl,
      verified,
      title: caption || `Reel by @${username}`,
      description: '',
      thumbnailUrl: String(firstPresent(r.thumbnailUrl, r.displayUrl, r.thumbnail) || ''),
      likesCount: likes,
      commentsCount: comments,
      viewCount: views,
      publishedAt,
      channel: { id: account ? account.id : null, name: fullName, handle: `@${username}`, logoUrl: profilePicUrl, verified },
    };
    scored.push({ row, score: instagramScore({ likes, comments, views, publishedAt }) });
  }

  scored.sort((a, b) => b.score - a.score);

  const scores = new Map();
  const perCreator = new Map();
  const out = [];
  for (const { row, score } of scored) {
    const creator = creatorKeyOf(row);
    if (creator !== null) {
      const used = perCreator.get(creator) || 0;
      if (used >= POOL.perCreatorCap) continue;
      perCreator.set(creator, used + 1);
    }
    scores.set(String(row.id), score);
    out.push(toClientInstagramRow(row));
    if (out.length >= POOL.igMax) break;
  }
  return { rows: out, scores };
}

function roundRobinByCreator(rows, scoreOf) {
  const queues = new Map();
  for (const row of rows) {
    const key = poolCreatorKey(row);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(row);
  }
  const lists = Array.from(queues.entries()).map(([key, items]) => {
    items.sort((a, b) => scoreOf(b) - scoreOf(a));
    return { key, items };
  });

  const out = [];
  let last = null;
  for (let round = 0; ; round += 1) {
    const heads = [];
    for (const q of lists) if (q.items.length > round) heads.push({ key: q.key, row: q.items[round] });
    if (heads.length === 0) break;

    heads.sort((a, b) => scoreOf(b.row) - scoreOf(a.row));
    if (last !== null && heads.length > 1 && heads[0].key === last) {
      const swap = heads.findIndex((h) => h.key !== last);
      if (swap > 0) [heads[0], heads[swap]] = [heads[swap], heads[0]];
    }
    for (const h of heads) out.push(h.row);
    last = heads[heads.length - 1].key;
  }
  return out;
}

function interleaveYtAndIg(ytRows, igRows, scoreOf) {
  const yts = [...ytRows].sort((a, b) => scoreOf(b) - scoreOf(a));
  const igs = [...igRows].sort((a, b) => scoreOf(b) - scoreOf(a));

  const out = [];
  let ytIdx = 0;
  let igIdx = 0;

  while (ytIdx < yts.length || igIdx < igs.length) {
    for (let k = 0; k < POOL.ytPerIg && ytIdx < yts.length; k += 1) {
      out.push(yts[ytIdx]);
      ytIdx += 1;
    }
    if (igIdx < igs.length) {
      out.push(igs[igIdx]);
      igIdx += 1;
    }
  }
  return out;
}

async function buildCandidatePool() {
  const started = Date.now();
  const [yt, ig] = await Promise.allSettled([loadYoutubeCandidates(), loadInstagramCandidates()]);
  if (yt.status === 'rejected') log.error(`pool: youtube candidates failed: ${yt.reason && yt.reason.message}`);
  if (ig.status === 'rejected') log.error(`pool: instagram candidates failed: ${ig.reason && ig.reason.message}`);

  const ytResult = yt.status === 'fulfilled' ? yt.value : { rows: [], scores: new Map() };
  const igResult = ig.status === 'fulfilled' ? ig.value : { rows: [], scores: new Map() };

  const scores = new Map();
  ytResult.scores.forEach((v, k) => scores.set(k, v));
  igResult.scores.forEach((v, k) => scores.set(k, v));

  const ytRows = roundRobinByCreator(ytResult.rows, (r) => scores.get(String(r.id)) || 0);
  const igRows = roundRobinByCreator(igResult.rows, (r) => scores.get(String(r.id)) || 0);

  const rows = interleaveYtAndIg(ytRows, igRows, (r) => scores.get(String(r.id)) || 0);
  if (rows.length === 0) throw new Error('pool build produced no candidates');

  const builtAt = Date.now();
  log.info(`pool built: ${rows.length} candidates (yt=${ytRows.length}, ig=${igRows.length}) in ${builtAt - started}ms`);
  return {
    version: `${builtAt}-${rows.length}`,
    builtAt,
    partial: yt.status !== 'fulfilled' || ig.status !== 'fulfilled',
    rows,
  };
}

async function readPoolFromRedis(redis, key) {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    return payload && Array.isArray(payload.rows) && payload.rows.length > 0 ? payload : null;
  } catch (err) {
    log.warn(`pool: redis read failed (${key}): ${err.message}`);
    return null;
  }
}

async function persistPool(redis, payload) {
  try {
    const json = JSON.stringify(payload);
    const pipe = redis.pipeline();
    pipe.set(POOL.redisKey, json, 'EX', POOL.redisTtlSec);
    if (!payload.partial) pipe.set(POOL.redisStaleKey, json, 'EX', POOL.staleTtlSec);
    assertPipeline(await pipe.exec());
  } catch (err) {
    log.warn(`pool: redis write failed: ${err.message}`);
  }
}

async function waitForPeerPool(redis) {
  const deadline = Date.now() + POOL.waitForPeerMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const peer = await readPoolFromRedis(redis, POOL.redisKey);
    if (peer && (!poolL1 || peer.builtAt > poolL1.builtAt)) return peer;
  }
  return null;
}

const poolSoftTtl = (pool) => (pool.partial ? POOL.partialSoftTtlMs : POOL.softTtlMs);

async function doRefreshPool() {
  const redis = safeRedis();

  if (redis && !poolDirty) {
    const shared = await readPoolFromRedis(redis, POOL.redisKey);
    if (
      shared &&
      (!poolL1 || shared.builtAt > poolL1.builtAt) &&
      Date.now() - shared.builtAt < (shared.partial ? POOL.partialSoftTtlMs : POOL.softTtlMs)
    ) {
      return setPool(shared);
    }
  }

  let token = null;
  if (redis) {
    token = `${process.pid}:${Date.now()}:${Math.random()}`;
    let acquired = null;
    try {
      acquired = await redis.set(POOL.redisLockKey, token, 'PX', POOL.lockTtlMs, 'NX');
    } catch (_) {
      acquired = null;
    }
    if (acquired !== 'OK') {
      token = null;
      const peer = await waitForPeerPool(redis);
      if (peer) return setPool(peer);
      if (poolL1) return poolL1;
    }
  }

  try {
    const payload = await buildCandidatePool();
    const pool = setPool(payload);
    if (redis) await persistPool(redis, payload);
    return pool;
  } catch (err) {
    log.error(`pool refresh failed: ${err.message}`);
    if (poolL1) return poolL1;
    if (redis) {
      const stale = await readPoolFromRedis(redis, POOL.redisStaleKey);
      if (stale) {
        log.warn('pool: serving the stale copy from Redis');
        return setPool(stale);
      }
    }
    throw err;
  } finally {
    if (redis && token && typeof redis.compareDel === 'function') {
      await redis.compareDel(POOL.redisLockKey, token).catch(() => {});
    }
  }
}

function refreshPool() {
  if (poolInflight) return poolInflight;
  const p = doRefreshPool()
    .then(
      (pool) => {
        poolRetryAt = 0;
        return pool;
      },
      (err) => {
        poolRetryAt = Date.now() + POOL.retryBackoffMs;
        throw err;
      }
    )
    .finally(() => {
      if (poolInflight === p) poolInflight = null;
    });
  poolInflight = p;
  return p;
}

async function getCandidatePool() {
  const now = Date.now();
  if (poolL1) {
    const age = now - poolL1.builtAt;
    if (!poolDirty && age < poolSoftTtl(poolL1)) return poolL1;
    if (now >= poolRetryAt) refreshPool().catch(() => {});
    if (age < POOL.hardStaleMs) return poolL1;
  }
  return refreshPool();
}

function invalidateCandidatePool() {
  poolDirty = true;
  poolRetryAt = 0;
  setImmediate(async () => {
    const redis = safeRedis();
    if (redis) await redis.del(POOL.redisKey).catch(() => {});
    refreshPool().catch((err) => log.warn(`pool rebuild after invalidation failed: ${err.message}`));
  });
}

function evictFromPool(ids) {
  if (!poolL1 || !ids || ids.length === 0) return;
  const drop = new Set(ids.map(String));
  const rows = poolL1.rows.filter((row) => !drop.has(String(row.id)));
  if (rows.length === poolL1.rows.length) return;
  setPool({
    version: `${poolL1.builtAt}-${rows.length}-e${Date.now()}`,
    builtAt: poolL1.builtAt,
    partial: poolL1.partial,
    rows,
  });
}

let feedEngineRef;
function loadFeedEngine() {
  if (feedEngineRef !== undefined) return feedEngineRef;
  try {
    feedEngineRef = require('../services/feedEngineService');
  } catch (err) {
    log.error(`feedEngineService unavailable: ${err.message}`);
    feedEngineRef = null;
  }
  return feedEngineRef;
}

const NO_SEEN = new Set();

async function serveFeedFromPool(viewer, { cursorRaw, page, limit }) {
  const pool = await getCandidatePool();
  const n = pool.rows.length;
  if (n === 0) throw new Error('candidate pool is empty');

  const take = Math.min(limit, n);
  const cursor = decodePoolCursor(cursorRaw);

  let start;
  if (cursor) {
    start = cursor.o;
    if (cursor.v !== pool.version && cursor.a && pool.index.has(cursor.a)) start = pool.index.get(cursor.a) + 1;
  } else {
    const base = viewer ? hashString(viewer.key) : Math.floor(Math.random() * n);
    start = base + (page - 1) * take;
    const group = POOL.ytPerIg + 1;
    start -= ((start % group) + group) % group;
  }
  start = ((start % n) + n) % n;

  const picked = [];
  const pickedIds = new Set();
  let cursorIdx = start;
  let lastIdx = start === 0 ? n - 1 : start - 1;
  let lastPickedIdx = null;
  let scanned = 0;
  let chunks = 0;
  const chunkSize = Math.max(take * POOL.scanFactor, take);

  while (picked.length < take && scanned < n && chunks < POOL.maxScanChunks) {
    chunks += 1;
    const len = Math.min(chunkSize, n - scanned);
    const chunk = new Array(len);
    for (let k = 0; k < len; k += 1) {
      const i = (cursorIdx + k) % n;
      chunk[k] = { i, id: String(pool.rows[i].id) };
    }
    const seen = viewer ? await getSeenSet(viewer, chunk.map((c) => c.id)) : NO_SEEN;

    for (const c of chunk) {
      scanned += 1;
      lastIdx = c.i;
      if (seen.has(c.id) || pickedIds.has(c.id)) continue;
      picked.push(pool.rows[c.i]);
      pickedIds.add(c.id);
      lastPickedIdx = c.i;
      if (picked.length >= take) break;
    }
    cursorIdx = (lastIdx + 1) % n;
  }

  let cycleReset = false;
  if (picked.length < take) {
    cycleReset = Boolean(viewer);
    let guard = 0;
    while (picked.length < take && guard < n) {
      const i = cursorIdx;
      cursorIdx = (cursorIdx + 1) % n;
      guard += 1;
      const row = pool.rows[i];
      const id = String(row.id);
      if (pickedIds.has(id)) continue;
      picked.push(row);
      pickedIds.add(id);
      lastPickedIdx = i;
    }
    if (cycleReset) setImmediate(() => trimSeenHistory(viewer, n));
  }

  if (!cursor && picked.length > 1 && platformOf(picked[0]) === 'ig') {
    const firstYt = picked.findIndex((r) => platformOf(r) === 'yt');
    if (firstYt > 0) [picked[0], picked[firstYt]] = [picked[firstYt], picked[0]];
  }

  const lastRow = picked[picked.length - 1];
  const nextOffset = lastPickedIdx === null ? start : (lastPickedIdx + 1) % n;
  const data = await attachLikes(picked, viewer && viewer.userId);

  return {
    data,
    hasMore: true,
    nextCursor: encodePoolCursor({ v: pool.version, o: nextOffset, a: lastRow ? String(lastRow.id) : null }),
    meta: { source: 'pool', poolSize: n, poolAgeMs: Date.now() - pool.builtAt, cycleReset },
  };
}

const fallbackServed = new Map();
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
  while (ids.size > FALLBACK_MAX_IDS) ids.delete(ids.values().next().value);
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
          `(SELECT ${seenCol('channelVideoId')} FROM ${seenTable} WHERE ${seenCol('userId')} = ${sequelize.escape(viewer.userId)})`
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
    fallbackServed.delete(viewer.key);
    rows = await run(false);
    cycled = rows.length > 0;
  }
  return { rows, cycled };
}

async function serveFeedFromDb(viewer, limit) {
  const { rows, cycled } = await dbFallbackFeed(viewer, limit);
  const ordered = diversifyFeed(rows, limit);
  rememberFallbackServed(viewer, ordered);
  const data = await attachLikes(ordered, viewer.userId);
  return { data, hasMore: true, meta: { source: 'db-fallback', cycleReset: cycled } };
}

async function resolveFeedPage({ viewer, cursorRaw, page, limit }) {
  try {
    return await serveFeedFromPool(viewer, { cursorRaw, page, limit });
  } catch (err) {
    log.error(`pool feed failed, falling back: ${err.message}`);
  }

  const engine = loadFeedEngine();
  if (engine && typeof engine.getFeed === 'function') {
    try {
      const userId = viewer ? viewer.userId || viewer.key : null;
      const result = await engine.getFeed(userId, cursorRaw, limit);
      const data = (result && result.data) || (Array.isArray(result) ? result : []);
      if (data.length > 0) {
        return {
          data,
          hasMore: Boolean(result && result.hasMore),
          nextCursor: (result && result.nextCursor) || null,
          meta: { source: 'feed-engine' },
        };
      }
    } catch (err) {
      log.error(`feedEngineService fallback failed: ${err.message}`);
    }
  }

  try {
    return await serveFeedFromDb(viewer || { key: 'anon', userId: null }, limit);
  } catch (err) {
    log.error(`database feed fallback failed: ${err.message}`);
  }
  return null;
}

function createFeedHandler({ requireViewer }) {
  return asyncHandler(async (req, res) => {
    const started = process.hrtime.bigint();
    const viewer = resolveViewer(req);
    if (!viewer && requireViewer) return fail(res, 401, 'Authentication or X-Device-Id header is required.');

    const limit = clampInt(req.query.limit, FEED_DEFAULT_LIMIT, 1, FEED_MAX_LIMIT);
    const cursorRaw = typeof req.query.cursor === 'string' && req.query.cursor.length <= CURSOR_MAX_LENGTH ? req.query.cursor : null;
    const page = clampInt(req.query.page, 1, 1, 10000);

    const result = await resolveFeedPage({ viewer, cursorRaw, page, limit });
    if (!result) {
      res.set('Retry-After', '3');
      return fail(res, 503, 'Feed temporarily unavailable. Please retry.');
    }

    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Authorization');
    res.set('Server-Timing', `feed;dur=${tookMs.toFixed(1)}`);
    return res.status(200).json({
      success: true,
      count: result.data.length,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
      data: result.data,
      meta: { ...result.meta, tookMs: Math.round(tookMs) },
    });
  });
}

exports.getShorts = createFeedHandler({ requireViewer: false });
exports.getFeed = createFeedHandler({ requireViewer: true });
exports.getShortsFeed = exports.getShorts;

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
    degraded = true;
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

const seenQueue = [];
let seenDraining = false;

function normalizeSeenEvents(rawEvents) {
  const list = Array.isArray(rawEvents) ? rawEvents.slice(0, SEEN_QUEUE.maxEventsPerBatch) : [];
  const ids = [];
  const events = [];
  const dedupe = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const cid = normalizeId(firstPresent(e.contentId, e.videoId, e.id));
    if (!cid) continue;
    const isIg = e.platform === 2 || e.platform === '2' || e.platform === 'instagram' || cid.startsWith('ig_');
    const id = isIg ? (cid.startsWith('ig_') ? cid : `ig_${cid}`) : cid;
    if (dedupe.has(id)) continue;
    dedupe.add(id);
    ids.push(id);
    events.push({ ...e, contentId: cid });
  }
  return { ids, events };
}

async function processSeenJob(job) {
  const { viewer, ids, events } = job;
  await Promise.allSettled([
    recordSeenIds(viewer, ids).catch((err) => log.warn(`seen history write failed: ${err.message}`)),
    (async () => {
      const engine = loadFeedEngine();
      if (engine && typeof engine.trackSeenBatch === 'function') {
        await engine.trackSeenBatch(viewer.userId || viewer.key, events);
      }
    })().catch((err) => log.error(`Background trackSeenBatch error: ${err.message}`)),
  ]);
}

async function drainSeenQueue() {
  try {
    while (seenQueue.length > 0) {
      const batch = seenQueue.splice(0, SEEN_QUEUE.concurrency);
      await Promise.allSettled(batch.map(processSeenJob));
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    seenDraining = false;
    if (seenQueue.length > 0) scheduleSeenDrain();
  }
}

function scheduleSeenDrain() {
  if (seenDraining) return;
  seenDraining = true;
  setImmediate(drainSeenQueue);
}

exports.trackSeenBatch = (req, res) => {
  res.status(200).json({ ok: true, success: true });

  try {
    const viewer = resolveViewer(req);
    if (!viewer) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { ids, events } = normalizeSeenEvents(body.events);
    if (ids.length === 0) return;

    if (seenQueue.length >= SEEN_QUEUE.queueMax) seenQueue.shift();
    seenQueue.push({ viewer, ids, events });
    scheduleSeenDrain();
  } catch (err) {
    log.error(`trackSeenBatch enqueue failed: ${err.message}`);
  }
};

let feedWorkersStarted = false;
let catalogTimer = null;
let flushTimer = null;

function startFeedWorkers() {
  if (feedWorkersStarted) return;
  feedWorkersStarted = true;

  seenTableReady = UserSeenVideo.sync().catch((err) => log.error(`user_seen_videos sync failed: ${err.message}`));
  getCandidatePool().catch((err) => log.warn(`pool warm-up failed: ${err.message}`));

  const catalogTick = async () => {
    try {
      await rebuildCatalog();
    } catch (err) {
      log.error(`catalog rebuild failed: ${err.message}`);
    }
    if (!feedWorkersStarted) return;
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
    if (!feedWorkersStarted) return;
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
    await flushViewEvents();
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

exports.startFeedWorkers = startFeedWorkers;
exports.stopFeedWorkers = stopFeedWorkers;
exports.refreshFeedCatalog = rebuildCatalog;
exports.warmFeedPool = () => getCandidatePool();
exports.invalidateFeedPool = invalidateCandidatePool;

exports.__test = {
  interleaveByChannel,
  interleaveYtAndIg,
  roundRobinByCreator,
  encodeCursor,
  decodeCursor,
  encodePoolCursor,
  decodePoolCursor,
  isValidShortDuration,
  diversifyFeed,
  parseTrackBody,
  normalizeSeenEvents,
  evaluateMediaUrl,
  isMockShortcode,
  resolveViewer,
};