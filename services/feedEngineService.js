/**
 * @file rcm-ai-backend/services/feedEngineService.js
 * @description Shorts & Reels feed engine with Bucket-Per-Creator Strategy & Strict 50/50 Round-Robin Interleaving.
 */

const { sequelize } = require('../config/db');
const { ChannelVideo, InstagramReel, Channel, InstagramAccount } = require('../models');
const { connection: redis } = require('../config/redis');
const { logger } = require('../utils/logger');
const { QueryTypes } = require('sequelize');

const PREFIX = 'rcm:engine:';
const RK = {
  catalog: `${PREFIX}catalog`,
  seen: (userId) => `${PREFIX}seen:${userId}`,
};

const PLATFORM = { youtube: 1, instagram: 2 };
const SEEN_TTL_MS = 48 * 3600 * 1000;
const SEEN_MAX_PER_USER = 2000;
const SEEN_BUFFER_MAX = 10000;
const POOL_TTL_MS = 90 * 1000;
const BATCH_LIMIT_PER_CREATOR = 10;

const redisReady = () => !!(redis && redis.status === 'ready');
const isNumericUser = (userId) => /^\d+$/.test(String(userId));

/* ------------------------------ helpers -------------------------------- */

function normalizePlatform(p) {
  if (p === 2 || p === '2') return PLATFORM.instagram;
  if (typeof p === 'string' && /^(instagram|ig)$/i.test(p.trim())) return PLATFORM.instagram;
  return PLATFORM.youtube;
}

function normalizeContentId(id) {
  const n = Number(String(id).replace(/^ig_/, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function shuffleArray(array) {
  let currentIndex = array.length;
  while (currentIndex !== 0) {
    const randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
}

/* ------------------------- DB circuit breaker -------------------------- */

let dbCircuitOpen = false;
let dbFailures = 0;
let circuitResetTimer = null;
const DB_CIRCUIT_THRESHOLD = 5;
const DB_CIRCUIT_RESET_MS = 30000;

function recordDbFailure() {
  dbFailures += 1;
  if (dbFailures >= DB_CIRCUIT_THRESHOLD && !dbCircuitOpen) {
    dbCircuitOpen = true;
    logger.error('[DB Circuit Breaker] Opened: repeated DB failures. Serving cached feed, buffering writes.');
    if (circuitResetTimer) clearTimeout(circuitResetTimer);
    circuitResetTimer = setTimeout(() => {
      dbCircuitOpen = false;
      dbFailures = 0;
      logger.info('[DB Circuit Breaker] Closed.');
    }, DB_CIRCUIT_RESET_MS);
    if (circuitResetTimer.unref) circuitResetTimer.unref();
  }
}
function recordDbSuccess() {
  if (dbFailures > 0) dbFailures -= 1;
}

/* ------------------- in-process seen memory (instant) ------------------- */

const memorySeen = new Map(); // userKey -> Map(member -> ts)
const MEM_USERS_MAX = 50000;

function memAdd(userKey, members, ts) {
  let m = memorySeen.get(userKey);
  if (!m) {
    if (memorySeen.size >= MEM_USERS_MAX) memorySeen.delete(memorySeen.keys().next().value);
    m = new Map();
    memorySeen.set(userKey, m);
  }
  for (const x of members) {
    m.delete(x);
    m.set(x, ts);
  }
  while (m.size > SEEN_MAX_PER_USER) m.delete(m.keys().next().value);
}

function memRead(userKey) {
  const m = memorySeen.get(userKey);
  const out = [];
  if (!m) return out;
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const [k, t] of m) {
    if (t < cutoff) m.delete(k);
    else out.push(k);
  }
  return out;
}

/* ----------------- batched DB persistence (user_seen_content) ------------ */

const seenBuffer = [];
let isFlushing = false;

async function flushSeenBuffer() {
  if (isFlushing || seenBuffer.length === 0 || dbCircuitOpen) return;
  isFlushing = true;
  const batch = seenBuffer.splice(0, 500);
  try {
    for (let i = 0; i < batch.length; i += 200) {
      const chunk = batch.slice(i, i + 200);
      const placeholders = chunk.map(() => '(?,?,?,?)').join(',');
      const flat = [];
      for (const it of chunk) flat.push(it.userId, it.platform, it.contentId, it.seenAt);
      await sequelize.query(
        `INSERT INTO user_seen_content (user_id, platform, content_id, seen_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE seen_at = VALUES(seen_at)`,
        { replacements: flat, type: QueryTypes.INSERT }
      );
    }
    recordDbSuccess();
  } catch (err) {
    logger.error(`[FeedEngine] Seen flush failed: ${err.message}`);
    recordDbFailure();
    const retry = batch.filter((b) => {
      b.tries = (b.tries || 0) + 1;
      return b.tries < 5;
    });
    if (seenBuffer.length + retry.length <= SEEN_BUFFER_MAX) seenBuffer.unshift(...retry);
  } finally {
    isFlushing = false;
  }
}

const flusherInterval = setInterval(flushSeenBuffer, 3000);
if (flusherInterval.unref) flusherInterval.unref();

async function gracefulFlush() {
  for (let i = 0; i < 5 && seenBuffer.length > 0; i += 1) await flushSeenBuffer();
}

/* ---------------------------- candidate pool (Bucket-Per-Creator & 50/50 Round-Robin) ----------------------------- */

let memoryPool = { data: null, expiresAt: 0 };
let poolPromise = null;

async function buildPool() {
  // 1. Fetch all active Instagram Accounts and active YouTube Channels
  const [igAccounts, ytChannels] = await Promise.all([
    InstagramAccount.findAll({
      where: { isActive: true },
      attributes: ['id', 'username', 'displayName', 'avatarUrl'],
      raw: true,
    }),
    Channel.findAll({
      where: { isActive: true },
      attributes: ['id', 'name', 'handle', 'logoUrl', 'youtubeChannelId'],
      raw: true,
    }),
  ]);

  logger.info(`[FeedEngine] Building candidate pool for ${igAccounts.length} Instagram accounts and ${ytChannels.length} YouTube channels.`);

  // 2. For EACH Instagram account, fetch a small batch of recent/random reels
  const instaQueues = [];
  for (const acc of igAccounts) {
    const reels = await InstagramReel.findAll({
      where: { accountId: acc.id, isActive: true },
      attributes: ['id', 'accountId', 'shortcode', 'url', 'title', 'thumbnailUrl', 'videoUrl', 'creatorHandle', 'likesCount', 'viewCount', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: BATCH_LIMIT_PER_CREATOR,
      raw: true,
    });

    if (reels && reels.length > 0) {
      const items = reels.map((r) => {
        const handle = acc.username || r.creatorHandle ? String(acc.username || r.creatorHandle).replace(/^@/, '') : '';
        const rawVideoUrl = r.videoUrl || r.directMediaUrl || r.mediaUrl || r.video_url || '';
        const isValidStream = rawVideoUrl && !rawVideoUrl.includes('instagram.com/reel/') && (rawVideoUrl.includes('.mp4') || rawVideoUrl.includes('cdninstagram.com') || rawVideoUrl.includes('mime=video'));
        const directVideo = isValidStream ? rawVideoUrl : null;
        const embedUrl = r.shortcode ? `https://www.instagram.com/reel/${r.shortcode}/embed/` : (r.url || '');
        const videoUrl = directVideo || (r.shortcode ? `https://www.instagram.com/reel/${r.shortcode}/` : rawVideoUrl);
        const thumbnailUrl = r.thumbnailUrl || r.thumbnail || '';
        return {
          id: `ig_${r.id}`,
          dbId: r.id,
          platform: 'instagram',
          uid: `${PLATFORM.instagram}:${r.id}`,
          shortcode: r.shortcode,
          url: r.url || videoUrl,
          embedUrl,
          directVideo,
          videoUrl: directVideo,
          directMediaUrl: directVideo,
          title: r.title || `Instagram Reel by @${handle}`,
          thumbnailUrl,
          thumbnail: thumbnailUrl,
          creatorHandle: handle ? `@${handle}` : '@instagram',
          category: acc.category || 'Motivation',
          likesCount: Number(r.likesCount) || 0,
          viewCount: Number(r.viewCount) || 0,
          createdAt: r.createdAt,
          channel: {
            id: acc.id,
            name: acc.displayName || acc.username || handle || 'Instagram Creator',
            handle: handle ? `@${handle}` : null,
            logoUrl: acc.avatarUrl || null,
          },
          creatorKey: `ig_${acc.id}`,
        };
      });

      instaQueues.push({
        creatorKey: `ig_${acc.id}`,
        name: acc.displayName || acc.username,
        items,
        idx: 0,
      });
    }
  }

  // 3. For EACH YouTube channel, fetch a small batch of recent shorts
  const youtubeQueues = [];
  for (const ch of ytChannels) {
    const videos = await ChannelVideo.findAll({
      where: { channelId: ch.id, isShort: true, isAvailable: true },
      attributes: ['id', 'channelId', 'title', 'thumbnailUrl', 'youtubeVideoId', 'viewCount', 'likesCount', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: BATCH_LIMIT_PER_CREATOR,
      raw: true,
    });

    if (videos && videos.length > 0) {
      const items = videos.map((v) => ({
        id: v.id,
        dbId: v.id,
        platform: 'youtube',
        uid: `${PLATFORM.youtube}:${v.id}`,
        videoId: v.youtubeVideoId,
        youtubeId: v.youtubeVideoId,
        youtubeVideoId: v.youtubeVideoId,
        videoUrl: `https://www.youtube.com/watch?v=${v.youtubeVideoId}`,
        directMediaUrl: `https://www.youtube.com/watch?v=${v.youtubeVideoId}`,
        embedUrl: `https://www.youtube.com/embed/${v.youtubeVideoId}`,
        title: v.title || `YouTube Short from ${ch.name}`,
        thumbnailUrl: v.thumbnailUrl || '',
        thumbnail: v.thumbnailUrl || '',
        creatorHandle: ch.handle ? (ch.handle.startsWith('@') ? ch.handle : `@${ch.handle}`) : `@${ch.name.replace(/\s+/g, '')}`,
        category: 'Motivation',
        likesCount: Number(v.likesCount) || 0,
        viewCount: Number(v.viewCount) || 0,
        createdAt: v.createdAt,
        channel: {
          id: ch.id,
          name: ch.name,
          handle: ch.handle,
          logoUrl: ch.logoUrl,
        },
        creatorKey: `yt_${ch.id}`,
      }));

      youtubeQueues.push({
        creatorKey: `yt_${ch.id}`,
        name: ch.name,
        items,
        idx: 0,
      });
    }
  }

  logger.info(`[FeedEngine] Active creator queues populated: ${instaQueues.length} Instagram queues, ${youtubeQueues.length} YouTube queues.`);

  // 4. Shuffle queues within each pool to ensure variety across requests/sessions
  shuffleArray(instaQueues);
  shuffleArray(youtubeQueues);

  // 5. Strict 50/50 Platform & Round-Robin Interleaving
  const out = [];
  let igQueuePtr = 0;
  let ytQueuePtr = 0;

  while (instaQueues.length > 0 || youtubeQueues.length > 0) {
    if (instaQueues.length > 0) {
      const q = instaQueues[igQueuePtr % instaQueues.length];
      if (q.idx < q.items.length) {
        out.push(q.items[q.idx]);
        q.idx++;
      }
      if (q.idx >= q.items.length) {
        instaQueues.splice(igQueuePtr % instaQueues.length, 1);
      } else {
        igQueuePtr = (igQueuePtr + 1) % instaQueues.length;
      }
    }

    if (youtubeQueues.length > 0) {
      const q = youtubeQueues[ytQueuePtr % youtubeQueues.length];
      if (q.idx < q.items.length) {
        out.push(q.items[q.idx]);
        q.idx++;
      }
      if (q.idx >= q.items.length) {
        youtubeQueues.splice(ytQueuePtr % youtubeQueues.length, 1);
      } else {
        ytQueuePtr = (ytQueuePtr + 1) % youtubeQueues.length;
      }
    }

    if (instaQueues.every(q => q.idx >= q.items.length) && youtubeQueues.every(q => q.idx >= q.items.length)) {
      break;
    }
    if (instaQueues.length === 0 && youtubeQueues.length === 0) {
      break;
    }
  }

  logger.info(`[FeedEngine] Final interleaved candidate pool constructed with ${out.length} items.`);
  return out;
}

async function getCandidatePool() {
  const now = Date.now();
  if (memoryPool.data && memoryPool.expiresAt > now) return memoryPool.data;

  if (redisReady()) {
    try {
      const cached = await redis.get(RK.catalog);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length) {
          memoryPool = { data: parsed, expiresAt: now + POOL_TTL_MS };
          return parsed;
        }
      }
    } catch (e) {
      /* Redis problems never break the feed */
    }
  }

  if (poolPromise) return poolPromise;

  poolPromise = (async () => {
    try {
      const pool = await buildPool();
      memoryPool = { data: pool, expiresAt: Date.now() + POOL_TTL_MS };
      recordDbSuccess();
      if (redisReady()) {
        try {
          await redis.set(RK.catalog, JSON.stringify(pool), 'EX', 90);
        } catch (e) {
          /* ignore */
        }
      }
      return pool;
    } catch (err) {
      logger.error(`[FeedEngine] Candidate pool DB query failed: ${err.message}`);
      recordDbFailure();
      if (memoryPool.data) return memoryPool.data;
      throw err;
    } finally {
      poolPromise = null;
    }
  })();
  return poolPromise;
}

function invalidateCandidateCache() {
  memoryPool.expiresAt = 0;
  if (redisReady()) redis.del(RK.catalog).catch(() => {});
}
global.invalidateFeedCandidateCache = invalidateCandidateCache;

/* ------------------------------- seen set -------------------------------- */

async function getSeenSet(userId) {
  const set = new Set(memRead(String(userId)));
  let redisOk = false;
  if (redisReady()) {
    try {
      const members = await redis.zrange(RK.seen(userId), 0, -1);
      members.forEach((m) => set.add(m));
      redisOk = true;
    } catch (e) {
      /* fall through to DB */
    }
  }
  if (!redisOk && isNumericUser(userId) && !dbCircuitOpen) {
    try {
      const rows = await sequelize.query(
        'SELECT platform, content_id FROM user_seen_content WHERE user_id = ? AND seen_at > (NOW() - INTERVAL 48 HOUR) LIMIT 2000',
        { replacements: [userId], type: QueryTypes.SELECT }
      );
      rows.forEach((r) => set.add(`${Number(r.platform)}:${r.content_id}`));
      recordDbSuccess();
    } catch (e) {
      recordDbFailure();
    }
  }
  return set;
}

async function resetSeen(userId) {
  memorySeen.delete(String(userId));
  if (redisReady()) {
    try {
      await redis.del(RK.seen(userId));
    } catch (e) {
      /* ignore */
    }
  }
  if (isNumericUser(userId)) {
    sequelize
      .query('DELETE FROM user_seen_content WHERE user_id = ?', { replacements: [userId], type: QueryTypes.DELETE })
      .catch(() => {});
  }
}

/* -------------------------------- service -------------------------------- */

const encodeCursor = (pos) => Buffer.from(JSON.stringify({ pos })).toString('base64url');
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const d = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Number.isInteger(d.pos) && d.pos > 0 ? d.pos : 0;
  } catch (e) {
    return 0;
  }
}

const feedEngineService = {
  trackSeenBatch: async (userId, events) => {
    if (!Array.isArray(events) || events.length === 0) return { accepted: 0 };

    const ts = Date.now();
    const valid = [];
    for (const ev of events.slice(0, 50)) {
      const contentId = normalizeContentId(ev && ev.contentId);
      if (contentId === null) continue;
      valid.push({ platform: normalizePlatform(ev.platform), contentId });
    }
    if (valid.length === 0) return { accepted: 0 };

    const members = valid.map((v) => `${v.platform}:${v.contentId}`);
    memAdd(String(userId), members, ts);

    if (redisReady()) {
      try {
        const key = RK.seen(userId);
        const pipeline = redis.pipeline();
        members.forEach((m) => pipeline.zadd(key, ts, m));
        pipeline.zremrangebyscore(key, 0, ts - SEEN_TTL_MS);
        pipeline.zremrangebyrank(key, 0, -(SEEN_MAX_PER_USER + 1));
        pipeline.expire(key, 48 * 3600);
        await pipeline.exec();
      } catch (e) {
        logger.warn(`[FeedEngine] Redis seen write skipped: ${e.message}`);
      }
    }

    if (isNumericUser(userId)) {
      const when = new Date(ts);
      for (const v of valid) {
        if (seenBuffer.length >= SEEN_BUFFER_MAX) seenBuffer.shift();
        seenBuffer.push({ userId: Number(userId), platform: v.platform, contentId: v.contentId, seenAt: when });
      }
    }
    return { accepted: valid.length };
  },

  getFeed: async (userId, cursor, limit = 10) => {
    const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

    let pool;
    try {
      pool = await getCandidatePool();
    } catch (err) {
      pool = [];
    }

    if (!pool || pool.length === 0) {
      try {
        const rows = await ChannelVideo.findAll({
          where: { isShort: true, isAvailable: true },
          attributes: ['id', 'channelId', 'title', 'thumbnailUrl', 'youtubeVideoId', 'viewCount', 'likesCount', 'createdAt'],
          include: [{ model: Channel, as: 'channel', attributes: ['id', 'name', 'handle', 'logoUrl'], required: false }],
          order: [['createdAt', 'DESC']],
          limit: cappedLimit,
          raw: true,
          nest: true,
        });
        const data = rows.map((v) => ({
          ...v,
          videoId: v.youtubeVideoId,
          youtubeId: v.youtubeVideoId,
          videoUrl: `https://www.youtube.com/watch?v=${v.youtubeVideoId}`,
          platform: 'youtube',
        }));
        return { data, nextCursor: null, hasMore: false };
      } catch (e) {
        return { data: [], nextCursor: null, hasMore: false };
      }
    }

    const seen = await getSeenSet(userId);
    const start = decodeCursor(cursor);

    const scan = (from) => {
      const picked = [];
      let i = from;
      for (; i < pool.length && picked.length < cappedLimit; i += 1) {
        if (!seen.has(pool[i].uid)) picked.push(pool[i]);
      }
      return { picked, next: i };
    };

    let { picked, next } = scan(start);

    if (picked.length === 0) {
      if (start > 0) {
        return { data: [], nextCursor: null, hasMore: false };
      }
      await resetSeen(userId);
      seen.clear();
      ({ picked, next } = scan(0));
    }

    const nextCursor = next < pool.length ? encodeCursor(next) : null;
    return { data: picked, nextCursor, hasMore: nextCursor !== null };
  },

  invalidateCandidateCache,
  gracefulFlush,
};

module.exports = feedEngineService;
