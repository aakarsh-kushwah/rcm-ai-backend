/**
 * @file server.js
 * @title RCM TITAN ASI ENGINE - GEN 11 (STABLE PRODUCTION CORE)
 * @description Hyper-Scale Distributed Architecture.
 * @status GOD MODE ENABLED | CRASH PROOF | REDIS FIXED
 */

require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default; 
const compression = require('compression');
const toobusy = require('toobusy-js'); 
const { connectDB, sequelize } = require('./models'); 

// ✅ FIX 1: LOAD CENTRAL REDIS (Split Brain Problem Solved)
// Hum wahi connection use karenge jo humne config/redis.js me banaya hai.
// Isme 'enableOfflineQueue: true' hai, to ye crash nahi karega.
const { connection: redisClient } = require('./config/redis');

// 🧠 SCALABILITY CONFIG
const PORT = process.env.PORT || 10000;
const TOTAL_CORES = process.env.NODE_ENV === 'production' ? os.cpus().length : 1;

// ============================================================
// 1. MASTER NODE (The Cosmic Brain)
// ============================================================
if (cluster.isPrimary) {
    console.clear();
    console.log(`
    /////////////////////////////////////////////////////////////////////////////////////////
    🚀 RCM TITAN ASI: THE OMNIPOTENT ENGINE IS IGNITING
    🧠 Master PID: ${process.pid} | 💻 Active Cores: ${TOTAL_CORES}
    🌍 OCI Region: ${process.env.AZURE_SPEECH_REGION || 'Central-India'}
    🗄️  DB: TiDB Distributed | ⚡ Redis: Unified Core Link
    /////////////////////////////////////////////////////////////////////////////////////////
    `);

    // Fork workers based on CPU cores
    for (let i = 0; i < TOTAL_CORES; i++) {
        cluster.fork();
    }

    // Auto-Respawn (Self-Healing Architecture)
    cluster.on('exit', (worker, code, signal) => {
        console.warn(`⚠️ [TITAN-REGEN] Worker ${worker.process.pid} died. Spawning replacement...`);
        cluster.fork();
    });

} else {
    // ============================================================
    // 2. WORKER NODE (The Neural Pathway)
    // ============================================================
    igniteNeuralPathway();
}

async function igniteNeuralPathway() {
    const app = express();

    // 🛡️ SELF-PRESERVATION SYSTEM
    app.use((req, res, next) => {
        if (toobusy()) {
            return res.status(503).json({ error: "Titan is processing heavy load. Please retry in seconds." });
        }
        next();
    });

    // 🚀 PERFORMANCE LAYERS
    app.set('trust proxy', 1); 
    app.use(compression()); 
    
    // 🛡️ SECURITY LAYERS
    app.use(helmet({ 
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: "cross-origin" }
    }));
    app.use(hpp()); 

    // 🌐 CORS (ENV DRIVEN)
    const allowedOrigins = [
        'https://rcm-ai-admin-ui.vercel.app',
        'https://rcmai.in',         // बिना www के
        'https://www.rcmai.in',     // ✅ नया जोड़ा (With www)
        'http://localhost:3000',
        'http://localhost:5173'
    ];

    app.use(cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
                return callback(null, true);
            }
            return callback(new Error('🚫 Titan Firewall: Origin Blocked'), false);
        },
        credentials: true
    }));

    // Body Parsers
    app.use(express.json({ limit: '50mb' })); 
    app.use(express.urlencoded({ limit: '50mb', extended: true }));

    // 🚦 DISTRIBUTED TRAFFIC CONTROL (CRASH PROOF)
    // ✅ FIX 2: Offline Queue Enabled (Via Config)
    // Ab agar Redis 1 sec late bhi connect hoga, to ye crash nahi karega.
    const standardLimiter = rateLimit({
        store: new RedisStore({
            // Hum directly central connection pass kar rahe hain
            sendCommand: (...args) => redisClient.call(...args),
        }),
        windowMs: 1 * 60 * 1000, 
        max: 5000, 
        message: { error: "Neural Overload. Scaling in progress..." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // ============================================================
    // 🛣️ ROUTES INTEGRATION
    // ============================================================
    
    app.get('/health', async (req, res) => {
        try {
            await sequelize.authenticate();
            res.status(200).json({ status: 'OK', health: 'DIVINE', worker: process.pid });
        } catch (e) {
            res.status(503).json({ status: 'ERROR', health: 'CRITICAL' });
        }
    });

    app.get('/', (req, res) => res.status(200).json({ 
        status: "ONLINE", 
        engine: "RCM Titan ASI",
        cloud: "Oracle Cloud Infrastructure"
    }));

    try {
        app.use('/api/auth', standardLimiter, require('./routes/authRoutes'));
        app.use('/api/chat', standardLimiter, require('./routes/chatRoutes'));
        
        // Critical Routes (Ab ye crash nahi karenge kyunki Redis fix ho gaya hai)
        app.use('/api/payment', require('./routes/paymentRoutes'));
        app.use('/api/notifications', require('./routes/notificationRoutes'));
        
        // app.use('/api/products', require('./routes/productRoutes'));
        // app.use('/api/sitemap', require('./routes/siteMapRoutes'));
        // app.use('/api/utils', require('./routes/utilRoutes'));
        app.use('/api/admin', require('./routes/adminRoutes'));
        app.use('/api/reports', require('./routes/dailyReportRoutes'));
        app.use('/api/videos', require('./routes/videoRoutes'));
    } catch (error) {
        console.error(`❌ [TITAN ROUTE ERROR]: ${error.message}`);
    }

    // ⚠️ GLOBAL ERROR TRAP
    app.use((err, req, res, next) => {
        if (process.env.NODE_ENV !== 'production') console.error(`🔥 Titan Fault:`, err);
        res.status(500).json({ 
            success: false, 
            message: "Titan Internal System Fault",
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    });

    // ============================================================
    // 🏁 IGNITION
    // ============================================================
    try {
        await connectDB(); 

        const server = app.listen(PORT, () => {
            console.log(`⚡ Titan Worker ${process.pid} serving on Port ${PORT}`);
        });

        server.keepAliveTimeout = 70000; 
        server.headersTimeout = 71000; 

        // Graceful Shutdown
        const shutdown = (signal) => {
            console.log(`🛑 ${signal} received. Worker ${process.pid} shutting down...`);
            server.close(async () => {
                await sequelize.close();
                process.exit(0);
            });
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        // Last line of defense: Uncaught Exception ko catch karo taaki server band na ho
        process.on('uncaughtException', (err) => {
            console.error('👾 Uncaught Exception (Handled):', err.message);
            // Process exit mat karo
        });

    } catch (error) {
        console.error(`❌ Startup Failure:`, error.message);
        process.exit(1);
    }
}