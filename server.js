/**
 * @file server.js
 * @description Core HTTP + Socket.io server. Nothing else.
 *   - No seeding        -> scripts/seedSuperAdmin.js
 *   - No background jobs -> workers/instagramWorker.js
 */

require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const pinoHttp = require("pino-http");
const socketIo = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const client = require("prom-client");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const cron = require('node-cron'); // Added node-cron

const { logger } = require("./utils/logger");
const { connectDB, sequelize, Channel, InstagramAccount } = require("./models"); // Added Channel, InstagramAccount
const { connection: redisClient } = require("./config/redis");
const { setIoInstance } = require("./services/socketService");
const { syncChannel } = require('./services/channelSyncService'); // Added syncChannel
const { syncAllAccounts: syncAllInstagramAccounts } = require('./services/instagramSyncService'); // Added Instagram sync service

// ============================================================
// ⚙️ CONFIG
// ============================================================
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 10000;

// Proxy hops between the socket and the real client.
// Render(local) -> Cloudflare -> client  = 3.
// Verify after deploy by logging req.ip for a known device.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 3);

// Your frontend (rcmai.in on Vercel) proxies /api to Render, so Cloudflare
// only sees Vercel's IP. Vercel puts the real user IP in x-vercel-forwarded-for.
const TRUST_VERCEL_IP = process.env.TRUST_VERCEL_IP !== "false";

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 300;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25 * 1000;
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";

const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'https://rcmai.in',
    'https://www.rcmai.in',
    'https://api.rcmai.in',
    'https://rcm-ai-admin-ui.vercel.app',
    process.env.FRONTEND_URL,
    process.env.ADMIN_URL,
    process.env.CLIENT_URL,
].filter(Boolean);

// ============================================================
// 🚀 APP + HTTP SERVER
// ============================================================
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY_HOPS); // must be before any middleware

const server = http.createServer(app);

// Set before listen() so they apply from the first connection.
// Must be higher than the load balancer idle timeout (~60s).
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

let isShuttingDown = false;

// ============================================================
// 📊 METRICS
// ============================================================
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
});

// ============================================================
// 🧰 HELPERS
// ============================================================
const getClientIp = (req) => {
    if (TRUST_VERCEL_IP) {
        const vercelIp = req.headers["x-vercel-forwarded-for"];
        if (vercelIp) return String(vercelIp).split(",")[0].trim();
    }
    return req.ip;
};

const buildRateLimitStore = () => {
    try {
        // npm i rate-limit-redis
        const { RedisStore } = require("rate-limit-redis");
        const sendCommand =
            typeof redisClient.call === "function"
                ? (...args) => redisClient.call(...args) // ioredis
                : (...args) => redisClient.sendCommand(args); // node-redis
        return new RedisStore({ sendCommand, prefix: "rl:global:" });
    } catch (err) {
        logger.warn(
            { err: err.message },
            "rate-limit-redis unavailable; using in-memory store (NOT shared across instances)"
        );
        return undefined;
    }
};

const isInfraPath = (req) => req.path === "/health" || req.path === "/metrics";

// ============================================================
// 🛡️ MIDDLEWARE
// ============================================================

// 1. Logging (minimal serializers: never log Authorization / Cookie / Set-Cookie)
app.use(
    pinoHttp({
        logger,
        genReqId: (req) => req.headers["x-trace-id"] || crypto.randomUUID(),
        autoLogging: { ignore: isInfraPath },
        serializers: {
            req: (req) => ({
                id: req.id,
                method: req.method,
                url: req.url,
                ip: req.raw && getClientIp(req.raw),
                userAgent: req.headers && req.headers["user-agent"],
            }),
            res: (res) => ({ statusCode: res.statusCode }),
        },
        customProps: (req) => ({ userId: req.user?.id }),
        customLogLevel: (req, res, err) => {
            if (err || res.statusCode >= 500) return "error";
            if (res.statusCode >= 400) return "warn";
            return "info";
        },
        customSuccessMessage: (req, res) => `${req.method} ${req.url} [${res.statusCode}]`,
    })
);

// 2. Metrics (low-cardinality route label)
app.use((req, res, next) => {
    if (isInfraPath(req)) return next();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
        const route = req.route ? `${req.baseUrl}${req.route.path}` : "unmatched";
        end({ method: req.method, route, status_code: res.statusCode });
    });
    next();
});

// 3. Security headers + compression
app.use(helmet({ crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" } }));
app.use(compression());

// 4. CORS (strict allowlist; handles preflight too, no separate app.options)
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(origin)) {
            return callback(null, true);
        }
        console.warn(`[CORS Blocked] Origin not allowed: ${origin}`);
        return callback(new Error(`CORS violation: origin not allowed (${origin})`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

// Ensure preflight OPTIONS are answered immediately with 204
app.options('*', cors());

// 5. Health + metrics BEFORE the rate limiter so probes are never throttled
let dbHealthy = false;

const checkDb = async () => {
    try {
        await sequelize.authenticate();
        dbHealthy = true;
    } catch (err) {
        dbHealthy = false;
        logger.error({ err: err.message }, "HealthCheck: database down");
    }
};

app.get("/health", (req, res) => {
    const ok = dbHealthy && !isShuttingDown;
    res.status(ok ? 200 : 503).json({
        status: ok ? "healthy" : isShuttingDown ? "shutting_down" : "degraded",
        timestamp: new Date().toISOString(),
    });
});

app.get("/metrics", async (req, res, next) => {
    try {
        if (METRICS_TOKEN && req.headers.authorization !== `Bearer ${METRICS_TOKEN}`) {
            return res.status(401).end();
        }
        res.setHeader("Content-Type", register.contentType);
        res.send(await register.metrics());
    } catch (err) {
        next(err);
    }
});

// 6. Global rate limiter (Redis-backed when rate-limit-redis is installed)
const globalLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    passOnStoreError: true, // Redis hiccup must not take the whole API down
    store: buildRateLimitStore(),
    keyGenerator: (req) => {
        const ip = getClientIp(req);
        return typeof ipKeyGenerator === "function" ? ipKeyGenerator(ip) : ip;
    },
    handler: (req, res) =>
        res.status(429).json({ success: false, message: "Too many requests, please try again later." }),
});
app.use(globalLimiter);

// 7. Parsers (small default. Raise per-route for upload endpoints only)
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

// ============================================================
// 🔌 SOCKET.IO
// ============================================================
const io = socketIo(server, {
    cors: { origin: allowedOrigins, credentials: true },
    transports: ["websocket", "polling"],
});
app.set("io", io);
setIoInstance(io);

const socketRedisClients = [];

const attachSocketRedisAdapter = async () => {
    try {
        if (redisClient.status !== 'ready') {
            logger.info("Redis is not connected; skipping Socket.io Redis adapter (running with in-memory adapter).");
            return;
        }
        const pubClient = redisClient.duplicate();
        const subClient = redisClient.duplicate();
        socketRedisClients.push(pubClient, subClient);

        pubClient.on('error', (err) => logger.warn({ err: err.message }, "[REDIS PUB CLIENT ERROR]"));
        subClient.on('error', (err) => logger.warn({ err: err.message }, "[REDIS SUB CLIENT ERROR]"));

        io.adapter(createAdapter(pubClient, subClient));
        logger.info("Socket.io Redis adapter attached");
    } catch (err) {
        logger.warn(
            { err: err.message },
            "Socket.io Redis adapter skipped (offline mode); running with in-memory adapter (single instance only)"
        );
    }
};

// ============================================================
// 🛣️ ROUTES
// ============================================================
const apiV1 = express.Router();

// More specific paths MUST be mounted before their parent ("/admin")
apiV1.use("/admin/instagram", require("./routes/instagramRoutes"));

apiV1.use("/auth", require("./routes/authRoutes"));
apiV1.use("/admin", require("./routes/adminRoutes"));
apiV1.use("/products", require("./routes/productRoutes"));
apiV1.use("/chat", require("./routes/chatRoutes"));
apiV1.use("/reports", require("./routes/dailyReportRoutes"));
apiV1.use("/notifications", require("./routes/notificationRoutes"));
apiV1.use("/payment", require("./routes/paymentRoutes"));
apiV1.use("/scraper", require("./routes/scraperRoutes"));
apiV1.use("/sitemap", require("./routes/siteMapRoutes"));
apiV1.use("/users", require("./routes/userRoutes"));
apiV1.use("/utils", require("./routes/utilsRoutes"));
apiV1.use("/videos", require("./routes/videoRoutes"));
apiV1.use("/channels", require("./routes/channelRoutes"));
apiV1.use("/calculator", require("./routes/calculatorRoutes"));
apiV1.use("/shorts", require("./routes/shortsRoutes"));

// /api/v1 is canonical; /api kept for backward compatibility
app.use("/api/v1", apiV1);
app.use("/api", apiV1);

// ============================================================
// ⚠️ 404 + ERROR HANDLING
// ============================================================
app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found", traceId: req.id });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;

    (status >= 500 ? logger.error : logger.warn).call(
        logger,
        { traceId: req.id, status, err: err.message, stack: status >= 500 && !IS_PROD ? err.stack : undefined },
        "Request failed"
    );

    if (res.headersSent) return next(err);

    res.status(status).json({
        success: false,
        message: status >= 500 && IS_PROD ? "Internal Server Error" : err.message,
        traceId: req.id,
    });
});

// ============================================================
// 🏁 STARTUP
// ============================================================
let healthTimer;

const startServer = async () => {
    try {
        await connectDB();
        await checkDb(); // so /health is correct immediately, not after 30s
        await attachSocketRedisAdapter();

        healthTimer = setInterval(checkDb, 30 * 1000);
        healthTimer.unref();

        server.listen(PORT, "0.0.0.0", () => {
            logger.info({ port: PORT, env: process.env.NODE_ENV, trustProxy: TRUST_PROXY_HOPS }, "Server online");

            // Configure scheduled task for incremental sync (every 4 hours)
            cron.schedule('0 */4 * * *', async () => {
                logger.info('[CRON] Starting scheduled incremental sync for all active accounts.');
                try {
                    // Sync YouTube Channels
                    const channels = await Channel.findAll({ where: { isActive: true } });
                    for (const channel of channels) {
                        try {
                            await syncChannel(channel);
                            logger.info(`[CRON] Channel sync successful for ${channel.name}.`);
                        } catch (error) {
                            logger.error(`[CRON] Channel sync failed for ${channel.name}: ${error.message}`);
                        }
                    }

                    // Sync Instagram Accounts
                    await syncAllInstagramAccounts();
                    logger.info('[CRON] Scheduled Instagram accounts sync initiated.');

                } catch (error) {
                    logger.error(`[CRON] Error during scheduled sync: ${error.message}`);
                }
                logger.info('[CRON] Finished scheduled incremental sync.');
            }, {
                scheduled: true,
                timezone: "Asia/Kolkata" // Or appropriate timezone for 4-6 hour interval calculation
            });
            logger.info('[CRON] Scheduled incremental sync set to run every 4 hours.');

        });
    } catch (err) {
        logger.fatal({ err: err.message, stack: err.stack }, "Startup failure");
        process.exit(1);
    }
};

// ============================================================
// 🛑 GRACEFUL SHUTDOWN
// ============================================================
const shutdown = async (signal, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`${signal} received. Starting graceful shutdown...`);

    const forceTimer = setTimeout(() => {
        logger.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
        clearInterval(healthTimer);

        // Stop accepting new connections; drop idle keep-alive sockets so close() can finish
        if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
        await new Promise((resolve) => io.close(() => resolve())); // also closes the HTTP server
        logger.info("HTTP + Socket.io drained.");

        const results = await Promise.allSettled([
            sequelize.close(),
            ...socketRedisClients.map((c) => c.quit()),
            redisClient.quit(),
        ]);
        results
            .filter((r) => r.status === "rejected")
            .forEach((r) => logger.warn({ err: r.reason?.message }, "Error during resource close"));

        logger.info("All connections closed. Bye.");
        process.exit(exitCode);
    } catch (err) {
        logger.error({ err: err.message }, "Error during shutdown");
        process.exit(1);
    }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "Uncaught exception");
    shutdown("uncaughtException", 1);
});

startServer();

module.exports = { app, server, io };