/**
 * shortsController.js  (Production-Hardened, Strict Short/Long Separation)
 *
 * Guarantees:
 *  - A video is a "Short" ONLY IF isShort = true AND 0 < totalSeconds <= 180.
 *  - Feed requests are served from a creator-interleaved candidate pool
 *    (YouTube Shorts + verified Instagram Reels, 2 YT : 1 IG) held in process memory (L1)
 *    and in Redis `shorts:feed:pool` (L2). Rebuilt in the background, one process at a time.
 *  - Instagram candidates come straight from InstagramReel joined with InstagramAccount
 *    (authentic profile picture, full name, verified flag). Seeded / mock reels and reels
 *    without a valid direct video URL are NEVER served, so there are no black screens.
 *  - /api/shorts/ig-stream/:shortcode is a 302 redirect engine:
 *    memory -> Redis (`ig:stream:<shortcode>`) -> DB -> live scrape capped at 600 ms ->
 *    404 { error: 'Stream unavailable' }. It never hangs, never proxies video bytes and
 *    never redirects to an Instagram web page.
 *  - /api/shorts/seen answers { ok: true } immediately; DB work runs from a bounded queue.
 *  - Atomic like/comment counters inside transactions.
 *  - SQL is written for MySQL / TiDB (backticks, ON DUPLICATE KEY UPDATE); a PostgreSQL
 *    branch is kept for the seen-history upsert so either dialect works.
 */

const asyncHandler = require('express-async-handler');
const axios = require('axios');
const { Op, DataTypes, QueryTypes, literal } = require('sequelize');
const { parse } = require('iso8601-duration');
const models = require('../models');
const { Channel, ChannelVideo, ShortInteraction, ShortComment, User } = models;
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

/** Candidate pool: the interleaved YouTube + Instagram list every feed request is served from. */
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
  ytPerIg: 2, // 2 YouTube Shorts : 1 Instagram Reel
};

/** Instagram stream redirect engine. */
const IG_STREAM = {
  l1Max: 20000,
  ttlMs: 4 * 60 * 60 * 1000,
  maxAgeSec: 14400,
  expirySafetyMs: 5 * 60 * 1000,
  minUsableMs: 60 * 1000,
  missTtlMs: 60 * 1000,
  missTtlSec: 60,
  redisTimeoutMs: 150,
  lookupBudgetMs: 400, // Redis + DB together
  scrapeTimeoutMs: 600, // HARD cap on any live scrape
  scrapeMaxConcurrent: 6,
  breakerFailures: 8,
  breakerOpenMs: 60 * 1000,
  maxContentBytes: 3 * 1024 * 1024,
};
const IG_MEDIA_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Seeded dummy shortcodes look like C2m3n4b5v6c / C5h6j7k8l9z (letter,digit alternating). */
const MOCK_SHORTCODE_RE = /^(?:[A-Za-z]\d){5}[A-Za-z]$/;
const MOCK_SHORTCODE_PREFIXES = ['C2m3n', 'C5f6', 'C5h6j'];
const isMockShortcode = (code) =>
  !code || MOCK_SHORTCODE_RE.test(code) || MOCK_SHORTCODE_PREFIXES.some((p) => String(code).startsWith(p));

/** Background queue for /seen analytics. */
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

/** Admin changes call this: clears the read caches and schedules a candidate pool rebuild. */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** FNV-1a 32-bit: a cheap, stable hash used to give every viewer a different starting point. */
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

/** Stable creator identity for YouTube channels and Instagram accounts (null when unknown). */
function creatorKeyOf(row) {
  if (!row) return null;
  const ch = row.channel && typeof row.channel === 'object' ? row.channel : {};
  const raw = firstPresent(row.channelId, row.accountId, row.creatorHandle, row.username, row.ownerUsername, ch.id, ch.handle);
  return raw === undefined ? null : String(raw);
}

const platformOf = (row) => (String(row.id).startsWith('ig_') ? 'ig' : 'yt');
const poolCreatorKey = (row) => `${platformOf(row)}:${creatorKeyOf(row) || '_'}`;

function lruSet(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}

function safeRequire(path) {
  try {
    return require(path);
  } catch (_) {
    return null;
  }
}

/** Only the attributes a model really has (the admin schema differs between deployments). */
const existingAttrs = (Model, names) =>
  Model && Model.rawAttributes ? names.filter((n) => Boolean(Model.rawAttributes[n])) : [];

/* -------------------------------------------------------------------------- */
/* Cursor helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Keyset cursor used by the per-channel feed. */
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

/** Stateless position cursor used by the global feed: v = pool version, o = next offset, a = last served id. */
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

/** Marks which rows the viewer liked. A failing likes lookup degrades to "not liked", never to a failed feed. */
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
/*                                                                            */
/* 302 redirect to the Instagram CDN MP4. Resolution order:                   */
/*   memory (0 ms) -> Redis `ig:stream:<shortcode>` -> DB -> live scrape      */
/*   (hard 600 ms) -> 404 { error: 'Stream unavailable' }                     */
/* Video bytes never pass through Node.                                       */
/* -------------------------------------------------------------------------- */

const igStream = {
  hits: new Map(), // shortcode -> { url, exp }
  misses: new Map(), // shortcode -> expiry (negative cache)
  inflight: new Map(), // shortcode -> Promise (request coalescing)
  activeScrapes: 0,
  breaker: { fails: 0, openUntil: 0 },
};

function setStreamCorsHeaders(res) {
  // Stops Chrome's NotSameOrigin blocking of the 302 hop to the CDN.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

/**
 * Accepts only https media URLs on the Instagram/Facebook CDN (or a plain .mp4) and never an
 * Instagram web page. Reads the CDN's own expiry (`oe`) so an expiring link is never cached longer than it lives.
 */
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

function streamCacheGet(shortcode) {
  const e = igStream.hits.get(shortcode);
  if (!e) return null;
  const remaining = e.exp - Date.now();
  if (remaining <= 0) {
    igStream.hits.delete(shortcode);
    return null;
  }
  return { url: e.url, ttlMs: remaining };
}

function streamCacheSet(shortcode, url, ttlMs) {
  lruSet(igStream.hits, shortcode, { url, exp: Date.now() + ttlMs }, IG_STREAM.l1Max);
  igStream.misses.delete(shortcode);
}

function streamIsMissed(shortcode) {
  const exp = igStream.misses.get(shortcode);
  if (!exp) return false;
  if (exp <= Date.now()) {
    igStream.misses.delete(shortcode);
    return false;
  }
  return true;
}

function streamMarkMiss(shortcode) {
  lruSet(igStream.misses, shortcode, Date.now() + IG_STREAM.missTtlMs, IG_STREAM.l1Max);
}

function getInstagramReelModel() {
  return models.InstagramReel || safeRequire('../models/InstagramReel');
}

function getInstagramAccountModel() {
  return models.InstagramAccount || safeRequire('../models/InstagramAccount');
}

/** Redis + database persistence of a freshly resolved URL. Always runs off the request path. */
function persistStreamUrl(shortcode, url, ttlMs) {
  setImmediate(async () => {
    const redis = safeRedis();
    if (redis) {
      try {
        await redis.set(`ig:stream:${shortcode}`, url, 'EX', Math.max(60, Math.floor(ttlMs / 1000)));
      } catch (_) {
        /* cache only */
      }
    }
    try {
      const Reel = getInstagramReelModel();
      if (Reel) await Reel.update({ videoUrl: url }, { where: { shortcode } });
    } catch (err) {
      log.warn(`ig-stream: could not store videoUrl for ${shortcode}: ${err.message}`);
    }
  });
}

function persistStreamMiss(shortcode) {
  setImmediate(async () => {
    const redis = safeRedis();
    if (!redis) return;
    try {
      await redis.set(`ig:stream:miss:${shortcode}`, '1', 'EX', IG_STREAM.missTtlSec);
    } catch (_) {
      /* cache only */
    }
  });
}

function forgetStream(shortcode) {
  igStream.hits.delete(shortcode);
  igStream.misses.delete(shortcode);
  const redis = safeRedis();
  if (redis) redis.del(`ig:stream:${shortcode}`, `ig:stream:miss:${shortcode}`).catch(() => {});
}

async function readStreamFromRedis(redis, shortcode) {
  const pipe = redis.pipeline();
  pipe.get(`ig:stream:${shortcode}`);
  pipe.pttl(`ig:stream:${shortcode}`);
  pipe.get(`ig:stream:miss:${shortcode}`);
  const results = assertPipeline(await withTimeout(pipe.exec(), IG_STREAM.redisTimeoutMs, 'redis'));
  return { url: results[0][1], pttl: Number(results[1][1]), missed: Boolean(results[2][1]) };
}

const scraperBreakerOpen = () => Date.now() < igStream.breaker.openUntil;

function scraperSucceeded() {
  igStream.breaker.fails = 0;
}

function scraperFailed() {
  igStream.breaker.fails += 1;
  if (igStream.breaker.fails >= IG_STREAM.breakerFailures) {
    igStream.breaker.openUntil = Date.now() + IG_STREAM.breakerOpenMs;
    igStream.breaker.fails = 0;
    log.warn(`ig-stream: scraper circuit opened for ${IG_STREAM.breakerOpenMs}ms`);
  }
}

/** One live lookup, hard-capped at IG_STREAM.scrapeTimeoutMs (600 ms). Returns { url, transient }. */
async function scrapeInstagramVideoUrl(shortcode) {
  const sessionId = process.env.INSTAGRAM_SESSION_ID;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    Accept: '*/*',
  };
  if (sessionId) headers.Cookie = `sessionid=${sessionId}; ds_user_id=${sessionId.split('%')[0]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IG_STREAM.scrapeTimeoutMs);
  try {
    const response = await axios.get(`https://www.instagram.com/reel/${shortcode}/?__a=1&__d=dis`, {
      headers,
      validateStatus: () => true,
      timeout: IG_STREAM.scrapeTimeoutMs,
      signal: controller.signal,
      maxContentLength: IG_STREAM.maxContentBytes,
      maxRedirects: 2,
    });

    if (response.status === 429 || response.status === 403 || response.status >= 500) {
      return { url: null, transient: true };
    }

    const data = response.data;
    let rawUrl =
      (data && data.items && data.items[0] && data.items[0].video_versions && data.items[0].video_versions[0] && data.items[0].video_versions[0].url) ||
      (data && data.graphql && data.graphql.shortcode_media && data.graphql.shortcode_media.video_url) ||
      null;

    if (!rawUrl && typeof data === 'string') {
      const ogMatch = data.match(/<meta property="og:video" content="([^"]+)"/i);
      const jsonMatch = data.match(/"video_url":"(https:[^"]+)"/i);
      rawUrl = ogMatch ? ogMatch[1] : jsonMatch ? jsonMatch[1] : null;
    }

    if (!rawUrl) return { url: null, transient: false };
    const cleaned = String(rawUrl).replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    return { url: cleaned, transient: false };
  } catch (err) {
    log.warn(`ig-stream live scrape failed for ${shortcode}: ${err.message}`);
    return { url: null, transient: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Redis -> database lookup (budgeted). Returns { url, ttlMs } | { url: null, missed? }. */
async function lookupStreamUrl(shortcode) {
  const redis = safeRedis();
  if (redis) {
    try {
      const hit = await readStreamFromRedis(redis, shortcode);
      if (hit.url) {
        const ev = evaluateMediaUrl(hit.url);
        if (ev) {
          const ttlMs = hit.pttl > 0 ? Math.min(hit.pttl, ev.ttlMs) : ev.ttlMs;
          streamCacheSet(shortcode, ev.url, ttlMs);
          return { url: ev.url, ttlMs };
        }
      }
      if (hit.missed) return { url: null, missed: true };
    } catch (_) {
      /* Redis slow or down: continue with the database */
    }
  }

  try {
    const Reel = getInstagramReelModel();
    if (Reel) {
      const row = await Reel.findOne({ where: { shortcode }, attributes: ['videoUrl'], raw: true });
      const ev = evaluateMediaUrl(row && row.videoUrl);
      if (ev) {
        streamCacheSet(shortcode, ev.url, ev.ttlMs);
        persistStreamUrl(shortcode, ev.url, ev.ttlMs);
        return { url: ev.url, ttlMs: ev.ttlMs };
      }
    }
  } catch (err) {
    log.warn(`ig-stream: DB lookup failed for ${shortcode}: ${err.message}`);
  }
  return { url: null };
}

/** Live scrape fallback: concurrency-limited, circuit-broken and capped at 600 ms. */
async function scrapeWithBudget(shortcode) {
  if (scraperBreakerOpen() || igStream.activeScrapes >= IG_STREAM.scrapeMaxConcurrent) return { url: null };
  igStream.activeScrapes += 1;
  try {
    const result = await withTimeout(scrapeInstagramVideoUrl(shortcode), IG_STREAM.scrapeTimeoutMs, 'live scrape');
    const ev = evaluateMediaUrl(result && result.url);
    if (ev) {
      scraperSucceeded();
      streamCacheSet(shortcode, ev.url, ev.ttlMs);
      persistStreamUrl(shortcode, ev.url, ev.ttlMs);
      return { url: ev.url, ttlMs: ev.ttlMs };
    }
    if (result && result.transient) scraperFailed();
    return { url: null };
  } catch (_) {
    scraperFailed();
    return { url: null };
  } finally {
    igStream.activeScrapes -= 1;
  }
}

async function doResolveStream(shortcode) {
  let found = { url: null };
  try {
    found = await withTimeout(lookupStreamUrl(shortcode), IG_STREAM.lookupBudgetMs, 'redis/db lookup');
  } catch (_) {
    found = { url: null };
  }
  if (found.url) return found;
  if (found.missed) {
    streamMarkMiss(shortcode);
    return { url: null };
  }

  // Cache and DB had nothing usable: one hard-capped live attempt, then give up.
  const scraped = await scrapeWithBudget(shortcode);
  if (scraped.url) return scraped;

  streamMarkMiss(shortcode);
  persistStreamMiss(shortcode);
  return { url: null };
}

/** Many players asking for the same reel trigger exactly one resolution. */
function resolveInstagramStream(shortcode) {
  if (igStream.inflight.has(shortcode)) return igStream.inflight.get(shortcode);
  const p = doResolveStream(shortcode).finally(() => {
    if (igStream.inflight.get(shortcode) === p) igStream.inflight.delete(shortcode);
  });
  igStream.inflight.set(shortcode, p);
  return p;
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

/**
 * GET /api/shorts/ig-stream/:shortcode
 * Always answers with either a 302 to the CDN MP4 or a clean 404 JSON. Never an HTML page,
 * never a redirect to instagram.com, never a hanging socket.
 */
exports.getInstagramStream = async (req, res) => {
  setStreamCorsHeaders(res); // first thing: headers must be on every response, including errors
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  try {
    if (req.method === 'OPTIONS') return res.status(204).end();

    const shortcode = req.params.shortcode;
    if (!shortcode || !SHORTCODE_RE.test(shortcode) || isMockShortcode(shortcode)) {
      return streamUnavailable(res);
    }

    // Hot path: in-process cache, no I/O at all.
    const hot = streamCacheGet(shortcode);
    if (hot) return redirectToMedia(res, hot.url, hot.ttlMs);
    if (streamIsMissed(shortcode)) return streamUnavailable(res);

    const result = await resolveInstagramStream(shortcode);
    if (result && result.url) return redirectToMedia(res, result.url, result.ttlMs);
    return streamUnavailable(res);
  } catch (err) {
    log.error(`ig-stream failed: ${err && err.message}`);
    if (res.headersSent) return undefined;
    return streamUnavailable(res);
  }
};

/**
 * POST /api/shorts/:id/unavailable
 * Public endpoint, so it never mutates video records. For Instagram reels it drops the cached
 * stream URL so the next request resolves a fresh one.
 */
exports.reportUnavailable = (req, res) => {
  res.status(200).json({ success: true });

  setImmediate(() => {
    try {
      const id = String((req.params && req.params.id) || '');
      if (!id.startsWith('ig_')) return;
      const shortcode = id.slice(3);
      if (SHORTCODE_RE.test(shortcode)) forgetStream(shortcode);
    } catch (err) {
      log.warn(`reportUnavailable failed: ${err.message}`);
    }
  });
};

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

/* -------------------------------------------------------------------------- */
/* Import: input extraction & detection                                       */
/* -------------------------------------------------------------------------- */

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
        } catch (_) {}
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
/* Import: operations                                                         */
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
/* Import: endpoint POST /api/admin/shorts/import-single                      */
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

/* ---------------------- durable seen history (SQL) -------------------------- */
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

/** The durable table only holds YouTube (numeric) video ids; Instagram ids stay in Redis. */
const isPersistableVideoId = (id) => /^\d+$/.test(String(id));

/** Quoted physical column name of a UserSeenVideo attribute (honours underscored models). */
const seenCol = (attr) =>
  sequelize.getQueryInterface().queryGenerator.quoteIdentifier(UserSeenVideo.rawAttributes[attr].field || attr);

/* --------------------------------- Redis ------------------------------------ */

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

// `let`: stopFeedWorkers() clears it on shutdown.
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

/** Redis is an accelerator, never a dependency: a missing or broken client yields null. */
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

/* ------------------------ seen history (never-repeat) ----------------------- */

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
    // Do not retry on every request while the history table is unavailable.
    try {
      await redis.set(RK.loaded(viewer.key), '1', 'EX', 60);
    } catch (_) {}
    throw err;
  }
}

/** Which of these ids has the viewer already seen? Fails open: on any problem nothing is filtered. */
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

/** The viewer has seen (almost) everything: keep only the newest slice so the feed starts a fresh cycle. */
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

/* --------------------- batched view persistence (Redis -> SQL) --------------- */

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

/** Bulk upsert of seen rows. MySQL / TiDB: ON DUPLICATE KEY UPDATE. PostgreSQL: ON CONFLICT. */
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

/* ----------------------- ranked catalog (engagement x freshness) ------------- */

const cvHas = (a) => Boolean(ChannelVideo.rawAttributes[a]);
const cvCol = (a) => `\`${ChannelVideo.name}\`.\`${ChannelVideo.rawAttributes[a].field || a}\``;
const cvNum = (a) => (cvHas(a) ? `COALESCE(${cvCol(a)}, 0)` : '0');

/**
 * TiDB / MySQL ranking expression (engagement x freshness):
 * ((LN(1 + likes*3 + comments*5 + views*0.02) + 1.0) * (0.15 + 0.85 * POW(0.5, GREATEST(age_hours, 0) / 72)))
 */
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

    // Instagram reels are added once per rebuild (not once per YouTube batch).
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

/* --------------------------------- diversity -------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Candidate pool: interleaved YouTube + Instagram list (Redis `shorts:feed:pool`) */
/* -------------------------------------------------------------------------- */

let poolL1 = null; // { version, builtAt, partial, rows, index }
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

const IG_VIDEO_KEYS = ['videoUrl', 'directVideo', 'direct_video', 'directVideoUrl', 'direct_video_url', 'video_url', 'mediaUrl', 'media_url', 'playbackUrl', 'playback_url'];

/** Instagram rows go to the client without raw CDN links: playback always uses the 302 endpoint. */
function toClientInstagramRow(row) {
  const out = { ...row };
  const derivedCode = String(out.id).replace(/^ig_/, '');
  const shortcode = String(out.shortcode || (SHORTCODE_RE.test(derivedCode) ? derivedCode : '') || '');
  if (shortcode) out.shortcode = shortcode;

  // Pre-warm the in-process stream cache so the first plays need no I/O.
  const ev = evaluateMediaUrl(firstPresent(...IG_VIDEO_KEYS.map((k) => out[k])));
  if (ev && shortcode && SHORTCODE_RE.test(shortcode)) streamCacheSet(shortcode, ev.url, ev.ttlMs);

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

/** Same engagement x freshness formula as the SQL, evaluated in JS for Instagram rows. */
function instagramScore({ likes, comments, views, publishedAt }) {
  const { wLike, wComment, wView, halfLifeHours, floor } = NF.ranking;
  const engagement = Math.log(1 + likes * wLike + comments * wComment + views * wView) + 1.0;
  const t = publishedAt ? new Date(publishedAt).getTime() : NaN;
  const ageHours = Number.isFinite(t) ? Math.max((Date.now() - t) / 3600000, 0) : halfLifeHours;
  return engagement * (floor + (1 - floor) * Math.pow(0.5, ageHours / halfLifeHours));
}

/**
 * Instagram candidates: InstagramReel JOINED with InstagramAccount (the Admin ecosystem).
 *  - join on reel.accountId = account.id OR reel.ownerUsername = account.username
 *  - authentic profilePicUrl / fullName / verified come from the account row
 *  - dummy / seeded shortcodes and reels without a valid direct video URL are dropped
 * The join is done with two plain queries so it works whatever association alias the admin
 * models use.
 */
async function loadInstagramCandidates() {
  const Reel = getInstagramReelModel();
  const Account = getInstagramAccountModel();
  if (!Reel || !Reel.rawAttributes || !Reel.rawAttributes.videoUrl || !Reel.rawAttributes.shortcode) {
    return { rows: [], scores: new Map() };
  }

  const reelAttrs = existingAttrs(Reel, [
    'id', 'shortcode', 'videoUrl', 'accountId', 'ownerUsername', 'username', 'caption', 'description',
    'thumbnailUrl', 'displayUrl', 'thumbnail', 'likesCount', 'commentsCount', 'playCount', 'viewCount',
    'videoPlayCount', 'takenAt', 'publishedAt', 'createdAt',
  ]);
  const where = { videoUrl: { [Op.like]: 'https://%' } }; // implies NOT NULL and a real URL
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

  // Account join.
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
        'id', 'username', 'fullName', 'profilePicUrl', 'verified', 'isVerified', 'followersCount', 'isActive',
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
    if (!SHORTCODE_RE.test(shortcode) || isMockShortcode(shortcode)) continue; // seeded dummy
    if (!evaluateMediaUrl(r.videoUrl)) continue; // no valid / unexpired direct stream

    const ownerName = String(firstPresent(r.ownerUsername, r.username) || '').replace(/^@+/, '');
    const account =
      (r.accountId != null && byId.get(String(r.accountId))) || (ownerName && byUsername.get(ownerName.toLowerCase())) || null;
    if (account && account.isActive === false) continue;

    const username = String((account && account.username) || ownerName || '').replace(/^@+/, '');
    if (!username) continue; // cannot show a creator handle: skip rather than render an anonymous reel

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

/**
 * Round-robin across creators: round r contains the r-th best item of every creator,
 * so the head of the feed is as varied as possible and no creator appears twice in a row.
 */
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

/** 2 YouTube Shorts : 1 verified Instagram Reel, YouTube first. */
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
  return { version: `${builtAt}-${rows.length}`, builtAt, partial: yt.status !== 'fulfilled' || ig.status !== 'fulfilled', rows };
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

  // 1. Another process may already have built a fresh pool.
  if (redis && !poolDirty) {
    const shared = await readPoolFromRedis(redis, POOL.redisKey);
    if (shared && (!poolL1 || shared.builtAt > poolL1.builtAt) && Date.now() - shared.builtAt < (shared.partial ? POOL.partialSoftTtlMs : POOL.softTtlMs)) {
      return setPool(shared);
    }
  }

  // 2. Only one process rebuilds at a time.
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
      // No peer result and nothing in memory: build locally rather than serve nothing.
    }
  }

  try {
    const payload = await buildCandidatePool();
    const pool = setPool(payload);
    if (redis) await persistPool(redis, payload);
    return pool;
  } catch (err) {
    log.error(`pool refresh failed: ${err.message}`);
    if (poolL1) return poolL1; // keep serving the last good pool
    if (redis) {
      const stale = await readPoolFromRedis(redis, POOL.redisStaleKey);
      if (stale) {
        log.warn('pool: serving the stale copy from Redis');
        return setPool(stale);
      }
    }
    throw err;
  } finally {
    if (redis && token && typeof redis.compareDel === 'function') await redis.compareDel(POOL.redisLockKey, token).catch(() => {});
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

/**
 * Hot path: returns the in-memory pool immediately. A soft-expired pool is still served while a
 * background refresh runs, so users only ever wait on a completely cold start.
 */
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

/** Admin change: purge the shared copy and rebuild in the background. */
function invalidateCandidatePool() {
  poolDirty = true;
  poolRetryAt = 0;
  setImmediate(async () => {
    const redis = safeRedis();
    if (redis) await redis.del(POOL.redisKey).catch(() => {});
    refreshPool().catch((err) => log.warn(`pool rebuild after invalidation failed: ${err.message}`));
  });
}

/** Immediately removes videos from this process's pool (deleted or no longer a Short). */
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

/* -------------------------------------------------------------------------- */
/* Global feed endpoint                                                       */
/* -------------------------------------------------------------------------- */

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

/**
 * Serves one page from the candidate pool. No database access on the hot path. The only I/O is
 * one small Redis round trip to skip what the viewer has already seen (and one likes lookup for
 * logged-in users). Page 1 (no cursor) always starts with a working YouTube Short so the first
 * paint never lands on an Instagram reel that needs a stream resolve.
 */
async function serveFeedFromPool(viewer, { cursorRaw, page, limit }) {
  const pool = await getCandidatePool();
  const n = pool.rows.length;
  if (n === 0) throw new Error('candidate pool is empty');

  const take = Math.min(limit, n);
  const cursor = decodePoolCursor(cursorRaw);

  let start;
  if (cursor) {
    start = cursor.o;
    // The pool was rebuilt since this cursor was issued: continue right after the last item served.
    if (cursor.v !== pool.version && cursor.a && pool.index.has(cursor.a)) start = pool.index.get(cursor.a) + 1;
  } else {
    const base = viewer ? hashString(viewer.key) : Math.floor(Math.random() * n);
    start = base + (page - 1) * take;
    // Align to the start of a (2 YT + 1 IG) group so the first items are YouTube.
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

  // The viewer has seen everything in the scanned window: keep the feed moving and start a fresh cycle.
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

  // Page 1 must open on a YouTube Short (instant load, no black screen).
  if (!cursor && picked.length > 1 && platformOf(picked[0]) === 'ig') {
    const firstYt = picked.findIndex((r) => platformOf(r) === 'yt');
    if (firstYt > 0) [picked[0], picked[firstYt]] = [picked[firstYt], picked[0]];
  }

  const lastRow = picked[picked.length - 1];
  const nextOffset = lastPickedIdx === null ? start : (lastPickedIdx + 1) % n;
  const data = await attachLikes(picked, viewer && viewer.userId);

  return {
    data,
    hasMore: true, // the feed cycles, it never ends
    nextCursor: encodePoolCursor({ v: pool.version, o: nextOffset, a: lastRow ? String(lastRow.id) : null }),
    meta: { source: 'pool', poolSize: n, poolAgeMs: Date.now() - pool.builtAt, cycleReset },
  };
}

/* -------------------- SQL fallback (last resort) ---------------------------- */

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
  // No nextCursor on purpose: clients then fall back to page-based paging and keep scrolling.
  return { data, hasMore: true, meta: { source: 'db-fallback', cycleReset: cycled } };
}

/** Pool first; if it cannot serve, the legacy engine; then the database. Returns null only if everything failed. */
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
/** GET /api/shorts/feed: YouTube Shorts + verified Instagram Reels, 2 : 1, YouTube first. */
exports.getShortsFeed = exports.getShorts;

/* -------------------------------------------------------------------------- */
/* View tracking                                                              */
/* -------------------------------------------------------------------------- */

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

/* ---------------- POST /api/shorts/seen : non-blocking analytics ------------- */

const seenQueue = [];
let seenDraining = false;

/** Maps the client's { contentId, platform } events to feed ids ('ig_' prefix for Instagram). */
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
      await new Promise((resolve) => setImmediate(resolve)); // let request handling run between batches
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

/**
 * POST /api/shorts/seen
 * Answers 200 { ok: true } BEFORE doing any work. Bookkeeping runs from a bounded queue; under
 * extreme load the oldest analytics batches are dropped instead of slowing the feed down.
 */
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

/* ---------------------------------- workers --------------------------------- */

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
/** Call once at server start so the very first visitor never waits for the pool build. */
exports.warmFeedPool = () => getCandidatePool();
exports.invalidateFeedPool = invalidateCandidatePool;

/* -------------------------------------------------------------------------- */
/* Exposed for unit tests only                                                */
/* -------------------------------------------------------------------------- */

exports.__test = {
  interleaveByChannel,
  interleaveYtAndIg,
  roundRobinByCreator,
  detectYouTubeInput,
  extractImportInput,
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