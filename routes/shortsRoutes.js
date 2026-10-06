/**
 * shortsRoutes.js   (mounted at /api/shorts)
 *
 *   GET  /              legacy chronological feed (public)
 *   GET  /feed          NEW never-repeat ranked feed (auth optional; guests send X-Device-Id)
 *   POST /track-view    NEW instant seen-history tracking (auth optional)
 *   GET  /channel/:channelId   shorts of one channel (public)
 *   POST /:id/like      like / unlike   (auth + active user)
 *   POST /:id/comments  add comment     (auth + active user)
 *   GET  /:id/comments  list comments   (public)
 *
 * If your frontend expects the spec URLs /api/feed/shorts and /api/feed/track-view, add to app.js:
 *   const { getFeed, trackView } = require('./controllers/shortsController');
 *   app.get('/api/feed/shorts', optionalAuth, getFeed);
 *   app.post('/api/feed/track-view', optionalAuth, express.json({ limit: '8kb' }), trackView);
 */

const express = require('express');
const {
  getShorts,
  getShortsByChannel,
  toggleLikeShort,
  addShortComment,
  getShortComments,
  getFeed,
  trackView,
  trackSeenBatch,
} = require('../controllers/shortsController');
const { isAuthenticated, isActiveUser } = require('../middleware/authMiddleware');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Optional auth: logged-in users get personal history, guests use X-Device-Id */
/* -------------------------------------------------------------------------- */

/**
 * No Authorization header  -> continue as guest (controller reads X-Device-Id).
 * Authorization header     -> full auth + active-user check (an invalid token is rejected, never
 *                             silently downgraded to guest).
 */
const optionalAuth = (req, res, next) => {
  if (!req.headers.authorization) return next();
  return isAuthenticated(req, res, (err) => {
    if (err) return next(err);
    return isActiveUser(req, res, next);
  });
};

/* -------------------------------------------------------------------------- */
/* Lightweight per-instance rate limiter (no extra dependency)                */
/* Safety net only – keep the real edge limits at nginx / API gateway / CDN.  */
/* Behind a proxy/LB set  app.set('trust proxy', 1)  so req.ip is the client. */
/* -------------------------------------------------------------------------- */

const LIMITER_MAX_KEYS = 100000;

function createLimiter({ windowMs, max, message }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  const keyOf = (req) => {
    if (req.user && req.user.id != null) return `u:${req.user.id}`;
    const device = req.headers['x-device-id'];
    if (typeof device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(device)) return `d:${device}`;
    return `ip:${req.ip}`;
  };

  return (req, res, next) => {
    const now = Date.now();
    const key = keyOf(req);
    let entry = hits.get(key);

    if (!entry || entry.reset <= now) {
      if (hits.size >= LIMITER_MAX_KEYS) hits.delete(hits.keys().next().value); // bounded memory
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));

    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.reset - now) / 1000))));
      return res.status(429).json({ success: false, message });
    }
    return next();
  };
}

const MINUTE = 60 * 1000;
const limitPublicRead = createLimiter({ windowMs: MINUTE, max: 300, message: 'Too many requests. Please slow down.' });
const limitFeed = createLimiter({ windowMs: MINUTE, max: 120, message: 'Too many feed requests. Please slow down.' });
const limitTrack = createLimiter({ windowMs: MINUTE, max: 300, message: 'Too many view events. Please slow down.' });
const limitLike = createLimiter({ windowMs: MINUTE, max: 120, message: 'Too many likes. Please slow down.' });
const limitComment = createLimiter({ windowMs: MINUTE, max: 20, message: 'Too many comments. Please slow down.' });

/* -------------------------------------------------------------------------- */
/* Small body parsers for the tracking endpoint (JSON + sendBeacon text/plain) */
/* -------------------------------------------------------------------------- */

const trackBodyParsers = [
  express.json({ limit: '8kb' }),
  express.text({ type: 'text/plain', limit: '8kb' }),
];

/* -------------------------------------------------------------------------- */
/* Feed (never-repeat, ranked, creator-diverse)                               */
/* -------------------------------------------------------------------------- */

router.get('/feed', optionalAuth, limitFeed, getFeed);
router.post('/track-view', optionalAuth, limitTrack, ...trackBodyParsers, trackView);
router.post('/seen', optionalAuth, limitTrack, express.json({ limit: '8kb' }), trackSeenBatch);

/* -------------------------------------------------------------------------- */
/* Public listing (legacy chronological + per channel)                         */
/* -------------------------------------------------------------------------- */

router.get('/', limitPublicRead, getShorts);
router.get('/channel/:channelId', limitPublicRead, getShortsByChannel);

/* -------------------------------------------------------------------------- */
/* Engagement                                                                 */
/* -------------------------------------------------------------------------- */

router.post('/:id/like', isAuthenticated, isActiveUser, limitLike, toggleLikeShort);
router.post('/:id/comments', isAuthenticated, isActiveUser, limitComment, addShortComment);
router.get('/:id/comments', limitPublicRead, getShortComments);

module.exports = router;