/**
 * @file server.js
 * @description Core HTTP + Socket.io server. Nothing else.
 *   - CORS config        -> config/cors.js
 *   - Rate limiting      -> middleware/rateLimiter.js
 *   - Metrics            -> middleware/metrics.js
 *   - Cron / sync jobs   -> workers/scheduler.js   (separate process)
 *   - Push fan-out       -> workers/notificationWorker.js (separate process)
 *   - Seeding            -> scripts/seedSuperAdmin.js
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

const { logger } = require("./utils/logger");
const { connectDB, sequelize } = require("./models");
const { connection: redisClient } = require("./config/redis");
const { setIoInstance } = require("./services/socketService");
const { allowedOrigins, corsOptions } = require("./config/cors");
const { globalLimiter, getClientIp } = require("./middleware/rateLimiter");
const { metricsMiddleware, metricsHandler } = require("./middleware/metrics");

// ============================================================
// ⚙️ CONFIG
// ============================================================
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 10000;

// Proxy hops between the socket and the real client.
// Render(local) -> Cloudflare -> client = 3. Verify after deploy by logging req.ip.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 3);

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25 * 1000;
// Time to keep serving while the load balancer notices /ready is failing.
const DRAIN_DELAY_MS = Number(process.env.DRAIN_DELAY_MS ?? 5000);
const REDIS_WAIT_MS = Number(process.env.REDIS_WAIT_MS) || 5000;

// Cloudflare already compresses responses for free. Enable only if you run without it.
const ENABLE_APP_COMPRESSION = process.env.ENABLE_COMPRESSION === "true";

// With several instances and no sticky sessions, use "websocket" only.
const SOCKET_TRANSPORTS = (process.env.SOCKET_TRANSPORTS || "websocket,polling")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

// ============================================================
// 🚀 APP + HTTP SERVER
// ============================================================
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY_HOPS); // must be before any middleware

const server = http.createServer(app);

// Must be higher than the load balancer idle timeout (~60s).
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;
// Whole request (incl. 10MB image uploads on slow mobile networks) must finish in 2 min.
server.requestTimeout = 120 * 1000;

let isShuttingDown = false;
let dbHealthy = false;

const isInfraPath = (req) =>
    req.path === "/health" || req.path === "/ready" || req.path === "/metrics";

// ============================================================
// 🛡️ MIDDLEWARE
// ============================================================

// 1. Logging (never log Authorization / Cookie / Set-Cookie)
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

// 2. Metrics
app.use(metricsMiddleware(isInfraPath));

// 3. Security headers (+ optional compression)
app.use(helmet({ crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" } }));
if (ENABLE_APP_COMPRESSION) app.use(compression());

// 4. CORS (strict allowlist; this middleware also answers preflight OPTIONS)
app.use(cors(corsOptions));

// 5. Infra endpoints BEFORE the rate limiter so probes are never throttled
const checkDb = async () => {
    try {
        await sequelize.authenticate();
        dbHealthy = true;
    } catch (err) {
        dbHealthy = false;
        logger.error({ err: err.message }, "HealthCheck: database down");
    }
};

// Liveness: "is the process alive?" Never fails because of DB. Fails only while shutting down.
app.get("/health", (req, res) => {
    res.status(isShuttingDown ? 503 : 200).json({
        status: isShuttingDown ? "shutting_down" : "alive",
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

// Readiness: "should traffic be routed here?"
app.get("/ready", (req, res) => {
    const ok = dbHealthy && !isShuttingDown;
    res.status(ok ? 200 : 503).json({
        status: ok ? "ready" : isShuttingDown ? "shutting_down" : "degraded",
        db: dbHealthy,
        redis: redisClient.status,
        timestamp: new Date().toISOString(),
    });
});

app.get("/metrics", metricsHandler);

// 6. Global rate limiter (Redis-backed when rate-limit-redis is installed)
app.use(globalLimiter);

// 7. Parsers (small default. Multipart uploads are handled by Multer inside the upload route)
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

// ============================================================
// 🔌 SOCKET.IO
// ============================================================
const io = socketIo(server, {
    cors: { origin: allowedOrigins, credentials: true },
    transports: SOCKET_TRANSPORTS,
    perMessageDeflate: false, // saves a lot of CPU at high connection counts
    pingInterval: 25 * 1000,
    pingTimeout: 20 * 1000,
    maxHttpBufferSize: 1e6,
});
app.set("io", io);
setIoInstance(io);

const socketRedisClients = [];

const waitForRedis = (timeoutMs) =>
    new Promise((resolve) => {
        if (redisClient.status === "ready") return resolve(true);

        const onReady = () => {
            clearTimeout(timer);
            resolve(true);
        };
        const timer = setTimeout(() => {
            redisClient.off("ready", onReady);
            resolve(false);
        }, timeoutMs);

        redisClient.once("ready", onReady);
    });

const attachSocketRedisAdapter = async () => {
    try {
        const ready = await waitForRedis(REDIS_WAIT_MS);
        if (!ready) {
            logger.warn(
                "Redis not ready after wait; Socket.io is running with in-memory adapter (single instance only)."
            );
            return;
        }

        const pubClient = redisClient.duplicate();
        const subClient = redisClient.duplicate();
        socketRedisClients.push(pubClient, subClient);

        pubClient.on("error", (err) => logger.warn({ err: err.message }, "[REDIS PUB CLIENT ERROR]"));
        subClient.on("error", (err) => logger.warn({ err: err.message }, "[REDIS SUB CLIENT ERROR]"));

        io.adapter(createAdapter(pubClient, subClient));
        logger.info("Socket.io Redis adapter attached");
    } catch (err) {
        logger.warn(
            { err: err.message },
            "Socket.io Redis adapter skipped; running with in-memory adapter (single instance only)"
        );
    }
};

// ============================================================
// 🛣️ ROUTES
// ============================================================
const apiV1 = express.Router();

// More specific paths MUST be mounted before their parent ("/admin")
apiV1.use("/admin/instagram", require("./routes/instagramRoutes"));

// 📸 Image upload (enable after routes/uploadRoutes.js is created in Step 1)
// apiV1.use("/upload", require("./routes/uploadRoutes"));

apiV1.use("/upload", require("./routes/uploadRoutes"));
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

/** Converts known library errors (Multer, body-parser) into correct 4xx responses. */
const normalizeError = (err) => {
    if (err && err.name === "MulterError") {
        switch (err.code) {
            case "LIMIT_FILE_SIZE":
                return { status: 413, message: "Image is too large. Maximum allowed size is 10MB." };
            case "LIMIT_UNEXPECTED_FILE":
                return { status: 400, message: "Unexpected file field. Upload the image using the field name 'image'." };
            default:
                return { status: 400, message: `Upload error: ${err.message}` };
        }
    }
    const status = err.status || err.statusCode || 500;
    return { status, message: err.message };
};

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const { status, message } = normalizeError(err);

    (status >= 500 ? logger.error : logger.warn).call(
        logger,
        { traceId: req.id, status, err: err.message, stack: status >= 500 && !IS_PROD ? err.stack : undefined },
        "Request failed"
    );

    if (res.headersSent) return next(err);

    res.status(status).json({
        success: false,
        message: status >= 500 && IS_PROD ? "Internal Server Error" : message,
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
        await checkDb(); // so /ready is correct immediately, not after 30s
        await attachSocketRedisAdapter();

        healthTimer = setInterval(checkDb, 30 * 1000);
        healthTimer.unref();

        server.listen(PORT, "0.0.0.0", () => {
            logger.info(
                { port: PORT, env: process.env.NODE_ENV, trustProxy: TRUST_PROXY_HOPS, transports: SOCKET_TRANSPORTS },
                "Server online"
            );
        });
    } catch (err) {
        logger.fatal({ err: err.message, stack: err.stack }, "Startup failure");
        process.exit(1);
    }
};

// ============================================================
// 🛑 GRACEFUL SHUTDOWN
// ============================================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shutdown = async (signal, exitCode = 0, { drain = true } = {}) => {
    if (isShuttingDown) return;
    isShuttingDown = true; // /ready and /health now return 503
    logger.info(`${signal} received. Starting graceful shutdown...`);

    const forceTimer = setTimeout(() => {
        logger.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
        clearInterval(healthTimer);

        // Give the load balancer time to stop routing new traffic here.
        if (drain && DRAIN_DELAY_MS > 0) await sleep(DRAIN_DELAY_MS);

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
process.on("SIGINT", () => shutdown("SIGINT", 0, { drain: false }));
process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
    // Process state may be corrupt: do not wait for drain, exit fast.
    logger.fatal({ err: err.message, stack: err.stack }, "Uncaught exception");
    shutdown("uncaughtException", 1, { drain: false });
});

startServer();

module.exports = { app, server, io };