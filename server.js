/**
 * @file server.js
 * @version 14.0.0 "THE ALPHA CORE"
 * @description Cloud-Native (Docker/K8s Ready) - OCI Optimized
 * @standard Enterprise Tier-0 (Zero-Trust, High-Observability)
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const pino = require("pino");
const pinoHttp = require("pino-http");
const socketIo = require("socket.io");
const { logger } = require("./utils/logger");
const { createAdapter } = require("@socket.io/redis-adapter");
const client = require("prom-client");
const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");

// Internal Modules
const bcrypt = require("bcryptjs");
const { connectDB, sequelize, User, Admin } = require("./models");
const { connection: redisClient } = require("./config/redis");
const { setIoInstance } = require("./services/socketService");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// 📊 OBSERVABILITY: Real-time Metrics & Lifecycle Tracing
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.1, 0.5, 1, 2, 5]
});
register.registerMetric(httpRequestDuration);

// ============================================================
// 🛡️ MIDDLEWARE STACK (Zero-Trust Architecture)
// ============================================================

// 1. Request Tracing & Performance Logging
app.use(pinoHttp({
    logger,
    genReqId: (req) => req.headers['x-trace-id'] || Math.random().toString(36).substring(7),
    customSuccessMessage: (req, res) => `✓ ${req.method} ${req.url} completed [${res.statusCode}]`,
}));

// 2. Metrics Integration (Request Lifecycle)
app.use((req, res, next) => {
    const end = httpRequestDuration.startTimer();
    res.on('finish', () => {
        end({ method: req.method, route: req.route?.path || req.path, status_code: res.statusCode });
    });
    next();
});

// 3. Hardened Security
app.use(helmet({
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
}));
app.use(compression());

// 4. Strict CORS (No Wildcards)
const allowedOrigins = [
    "https://rcmai.in",
    "https://www.rcmai.in",
    "https://rcm-ai-admin-ui.vercel.app",
    "http://localhost:3000", // For local development
    "http://localhost:3001", // For local development
    "http://localhost:5173"  // For local development
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("🚫 Titan Firewall: CORS Violation"), false);
        }
    },
    credentials: true
}));

// 5. Distributed Rate Limiting (Redis Optimized)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    store: new RedisStore({
        sendCommand: (...args) => redisClient.call(...args),
        prefix: "titan_rl:",
    }),
});
app.use(globalLimiter);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ============================================================
// 🚦 CORE ENGINE COMPONENTS
// ============================================================

// Redis Adapter for Scaling (Docker/K8s Friendly)
// server.js mein isey dhundo aur badlo
const io = socketIo(server, {
    cors: { 
        origin: allowedOrigins, 
        credentials: true 
    },
    transports: ['websocket', 'polling'], // 👈 'polling' ko wapas add karo
    allowEIO3: true // Backward compatibility ke liye (optional)
});

// ============================================================
// 🛣️ ROUTES & OBSERVABILITY ENDPOINTS
// ============================================================

// Prometheus Scraping Endpoint
app.get("/metrics", async (req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
});

// Lightweight Health Check (Caching DB Status)
let lastDbCheck = false;
setInterval(async () => {
    try {
        await sequelize.authenticate();
        lastDbCheck = true;
    } catch (e) {
        lastDbCheck = false;
        logger.error("HealthCheck: Database Down");
    }
}, 30000);

app.get("/health", (req, res) => {
    const status = lastDbCheck ? 200 : 503;
    res.status(status).json({
        status: lastDbCheck ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
        version: "14.0.0-alpha"
    });
});

// API v1 Mounting
const apiV1 = express.Router();

// Import Routes
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
apiV1.use("/calculator", require("./routes/calculatorRoutes"));

// Mount under both /api and /api/v1 for compatibility
app.use("/api/v1", apiV1);
app.use("/api", apiV1);

// ⚠️ GLOBAL ERROR HANDLER (Environment Aware)
app.use((err, req, res, next) => {
    const isProd = process.env.NODE_ENV === "production";
    logger.error({ 
        traceId: req.id, 
        msg: err.message, 
        stack: isProd ? null : err.stack 
    }, "Internal Fault");

    res.status(err.status || 500).json({
        success: false,
        message: isProd ? "Internal Server Error" : err.message,
        traceId: req.id
    });
});

// ============================================================
// 🏁 GRACEFUL IGNITION PROTOCOL
// ============================================================
const initSuperAdmin = async () => {
    const superAdminEmail = "rcmaiasistant@gmail.com";
    const defaultPassword = process.env.SUPER_ADMIN_DEFAULT_PASSWORD || "admin123"; // Use environment variable or a strong default
    const SALT_ROUNDS = 10; // Make sure this matches authController

    try {
        const existingSuperAdmin = await Admin.findOne({ where: { email: superAdminEmail } });

        if (!existingSuperAdmin) {
            const hashedPassword = await bcrypt.hash(defaultPassword, SALT_ROUNDS);
            await Admin.create({
                name: "Super Admin", // Changed from fullName to name
                email: superAdminEmail,
                masterPassword: hashedPassword, // Changed from password to masterPassword
                role: "SUPER_ADMIN", // Explicitly set as SUPER_ADMIN
                status: "active",
                isApproved: true,
            });
            logger.info("✅ Super Admin user created in Admin model: rcmaiasistant@gmail.com");
        } else {
            logger.info("Super Admin user already exists in Admin model: rcmaiasistant@gmail.com");
            if (existingSuperAdmin.role !== "SUPER_ADMIN" || !existingSuperAdmin.isApproved || existingSuperAdmin.status !== "active") {
                await existingSuperAdmin.update({ role: "SUPER_ADMIN", status: "active", isApproved: true });
                logger.info("Super Admin role and approval status updated in Admin model.");
            }
        }
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, "Error setting up Super Admin");
    }
};

const startServer = async () => {
    try {
        await connectDB();
        await initSuperAdmin(); // Call super admin setup here
        server.listen(PORT, () => {
            logger.info(`⚡ TITAN ALPHA-14 ONLINE [Port: ${PORT}]`);
        });

        // OCI Keep-Alive Optimization
        server.keepAliveTimeout = 61000;
        server.headersTimeout = 65000;

    } catch (err) {
        logger.fatal(err, "Startup Failure");
        process.exit(1);
    }
};

startServer();

// Graceful Shutdown (Memory & Connection Drain)
const shutdown = async (signal) => {
    logger.info(`🛑 ${signal} received. Initiating Graceful Shutdown...`);
    server.close(async () => {
        logger.info("HTTP Server drained.");
        await sequelize.close();
        await redisClient.quit();
        logger.info("All connections closed. Titan Off.");
        process.exit(0);
    });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

