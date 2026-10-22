/**
 * @file middleware/rateLimiter.js
 * @description Redis-backed rate limiters + real client IP helper.
 */

const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { logger } = require("../utils/logger");
const { connection: redisClient } = require("../config/redis");

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 300;

// Vercel puts the real user IP in x-vercel-forwarded-for.
// SECURITY: keep this enabled only if api.rcmai.in is NOT directly reachable by the public.
const TRUST_VERCEL_IP = process.env.TRUST_VERCEL_IP !== "false";

const getClientIp = (req) => {
    if (TRUST_VERCEL_IP) {
        const vercelIp = req.headers["x-vercel-forwarded-for"];
        if (vercelIp) return String(vercelIp).split(",")[0].trim();
    }
    return req.ip;
};

const buildStore = (prefix) => {
    // If Redis is offline or not ready, do not pass rate-limit-redis store config;
    // express-rate-limit will use its built-in memory store by default.
    if (!redisClient || redisClient.status !== "ready") {
        return undefined;
    }
    try {
        const { RedisStore } = require("rate-limit-redis");
        const sendCommand =
            typeof redisClient.call === "function"
                ? (...args) => redisClient.call(...args) // ioredis
                : (...args) => redisClient.sendCommand(args); // node-redis
        return new RedisStore({ sendCommand, prefix });
    } catch (err) {
        logger.warn(
            { err: err.message },
            "rate-limit-redis unavailable; using in-memory store (NOT shared across instances)"
        );
        return undefined;
    }
};

/** Default key: client IP. */
const ipBasedKey = (req) => {
    const ip = getClientIp(req);
    return typeof ipKeyGenerator === "function" ? ipKeyGenerator(ip) : ip;
};

/** Per-user key (req.user.id). Falls back to IP for guests. Use AFTER the auth middleware. */
const userKeyGenerator = (req) => (req.user && req.user.id ? `user:${req.user.id}` : ipBasedKey(req));

/** Factory so individual routes (upload, login, token register, broadcast) get their own limits. */
const createLimiter = ({
    windowMs = RATE_LIMIT_WINDOW_MS,
    limit = RATE_LIMIT_MAX,
    prefix = "rl:custom:",
    message,
    keyGenerator = ipBasedKey,
} = {}) => {
    const store = buildStore(prefix);
    const config = {
        windowMs,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        passOnStoreError: true, // a Redis hiccup must not take the API down
        keyGenerator,
        skip: (req) => req.method === "OPTIONS",
        handler: (req, res) =>
            res.status(429).json({
                success: false,
                message: message || "Too many requests, please try again later.",
            }),
    };
    if (store) {
        config.store = store;
    }
    return rateLimit(config);
};

const globalLimiter = createLimiter({ prefix: "rl:global:" });

module.exports = { globalLimiter, createLimiter, userKeyGenerator, getClientIp };
