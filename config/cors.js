/**
 * @file config/cors.js
 * @description Single source of truth for allowed origins and CORS options.
 */

const IS_PROD = process.env.NODE_ENV === "production";

const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    "https://rcmai.in",
    "https://www.rcmai.in",
    "https://api.rcmai.in",
    "https://rcm-ai-admin-ui.vercel.app",
    process.env.FRONTEND_URL,
    process.env.ADMIN_URL,
    process.env.CLIENT_URL,
]
    .filter(Boolean)
    .map((origin) => origin.replace(/\/+$/, ""));

// Local network testing (phone on the same Wi-Fi) is allowed only outside production.
const LAN_ORIGIN_REGEX = /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/;

const isOriginAllowed = (origin) =>
    !origin || // same-origin, server-to-server, curl, mobile apps
    allowedOrigins.includes(origin) ||
    (!IS_PROD && LAN_ORIGIN_REGEX.test(origin));

const corsOptions = {
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) return callback(null, true);

        const err = new Error(`CORS violation: origin not allowed (${origin})`);
        err.status = 403; // 403 (client error), not 500
        return callback(err);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin", "X-Trace-Id"],
    maxAge: 86400, // browsers cache preflight for 24h, so far fewer OPTIONS requests
};

module.exports = { allowedOrigins, corsOptions, isOriginAllowed };