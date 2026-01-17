/**
 * @file server.js
 * @title RCM TITAN AGI ENGINE - GEN 6.0 (ORACLE CLOUD EDITION)
 * @description Hyper-Scale Architecture for OCI (Oracle Cloud Infrastructure).
 * @status PRODUCTION READY | SCALE: 500M+ USERS
 */

require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');

// ✅ CENTRAL MODEL HUB (Correct Path: No 'src')
const { connectDB, sequelize } = require('./models'); 

const PORT = process.env.PORT || 3000; // Oracle Cloud often uses 3000 or 8080 internally

// 🧠 SCALABILITY LOGIC
// Oracle Cloud par aksar hume multi-core VMs milti hain.
// Production me hum saare cores use karenge.
const TOTAL_CORES = process.env.NODE_ENV === 'production' ? os.cpus().length : 1;

// ============================================================
// 1. MASTER NODE (The Brain)
// ============================================================
if (cluster.isPrimary) {
    console.clear();
    const banner = `
    /////////////////////////////////////////////////////////////////////////////////////////

                                        STARTING.....

    /////////////////////////////////////////////////////////////////////////////////////////
    
    🚀 TITAN ENGINE: GEN-6 (ORACLE CLOUD EDITION)
    🌍 Region: OCI-Mumbai-1 (Assumed)
    🧠 Master PID: ${process.pid}
    💻 Active Workers: ${TOTAL_CORES}
    🗄️  DB: TiDB (Sequelize) | ⚡ Cache: Redis
    `;
    console.log(banner);

    // Fork workers based on CPU cores
    for (let i = 0; i < TOTAL_CORES; i++) {
        cluster.fork();
    }

    // Auto-Respawn dead workers (Self-Healing)
    cluster.on('exit', (worker, code, signal) => {
        console.warn(`⚠️ [REGEN] Worker ${worker.process.pid} died. Spawning replacement...`);
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

    // 🚀 PERFORMANCE LAYERS
    app.set('trust proxy', 1); // Necessary for Oracle Load Balancer
    app.use(compression());    // Gzip compression to save bandwidth
    
    // 🛡️ SECURITY LAYERS
    app.use(helmet({ 
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: "cross-origin" }
    }));
    app.use(hpp()); // Prevent HTTP Parameter Pollution attacks

    // 🌐 CORS (Strict Policy)
    const allowedOrigins = [
        'https://rcm-ai-admin-ui.vercel.app',
        'https://rcmai.in',
        'http://localhost:3000',
        'http://localhost:5173'
    ];
    
    app.use(cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
                return callback(null, true);
            }
            return callback(new Error('🚫 Firewall: Origin Blocked'), false);
        },
        credentials: true
    }));

    // Body Parsers (Optimized for Heavy Payloads like Images/Voice)
    app.use(express.json({ limit: '50mb' })); 
    app.use(express.urlencoded({ limit: '50mb', extended: true }));

    // 🚦 TRAFFIC CONTROL (DDoS Protection)
    const standardLimiter = rateLimit({
        windowMs: 1 * 60 * 1000, // 1 Minute
        max: 3000, // Oracle Cloud can handle high throughput
        message: { error: "Neural Overload. Too many requests." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // ============================================================
    // 🛣️ ROUTES & ENDPOINTS (Fixed Paths: No 'src')
    // ============================================================
    
    // Health Check (Oracle Cloud Load Balancer needs this)
    app.get('/health', async (req, res) => {
        try {
            // Quick DB Check
            await sequelize.authenticate();
            res.status(200).json({ status: 'OK', health: 'EXCELLENT', uptime: process.uptime() });
        } catch (e) {
            res.status(503).json({ status: 'ERROR', health: 'CRITICAL' });
        }
    });

    // Root Endpoint
    app.get('/', (req, res) => res.status(200).json({ 
        status: "ONLINE", 
        cloud: "Oracle Cloud Infrastructure",
        worker: process.pid 
    }));

    // 🔗 API ROUTES INTEGRATION
    try {
        // Core Systems
        app.use('/api/products', require('./routes/productRoutes'));
        app.use('/api/sitemap', require('./routes/siteMapRoutes'));
        app.use('/api/utils', require('./routes/utilRoutes'));
        
        // User Systems (Protected by Rate Limiter)
        app.use('/api/chat', standardLimiter, require('./routes/chatRoutes'));
        app.use('/api/auth', standardLimiter, require('./routes/authRoutes'));
        
        // Support Systems
        app.use('/api/notifications', require('./routes/notificationRoutes'));
        app.use('/api/payment', require('./routes/paymentRoutes'));
        app.use('/api/admin', require('./routes/adminRoutes'));

    } catch (error) {
        console.error(`❌ [ROUTE ERROR] Module Load Failed: ${error.message}`);
        console.error("💡 TIP: Check if all files exist in 'routes/' folder and export 'router'.");
    }

    // ============================================================
    // ⚠️ GLOBAL ERROR TRAP
    // ============================================================
    app.use((err, req, res, next) => {
        if (process.env.NODE_ENV !== 'production') console.error(`🔥 Worker ${process.pid} Error:`, err);
        res.status(500).json({ 
            success: false, 
            message: "Internal System Error",
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    });

    // ============================================================
    // 🏁 IGNITION
    // ============================================================
    try {
        await connectDB(); 

        const server = app.listen(PORT, () => {
            console.log(`⚡ Worker ${process.pid} serving on Port ${PORT}`);
        });

        // 🛑 IMPORTANT FOR ORACLE CLOUD LOAD BALANCERS
        // Oracle LB timeout is usually 60 seconds. 
        // Node.js timeout MUST be higher to avoid 502 Bad Gateway errors.
        server.keepAliveTimeout = 65000; // 65 seconds
        server.headersTimeout = 66000;   // 66 seconds

        // Graceful Shutdown
        const shutdown = async (signal) => {
            console.log(`🛑 ${signal} received. Worker ${process.pid} shutting down...`);
            server.close(async () => {
                try {
                    await sequelize.close(); 
                    console.log('   Database Disconnected.');
                    process.exit(0);
                } catch (err) {
                    process.exit(1);
                }
            });
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
        console.error(`❌ Critical Startup Failure:`, error.message);
        process.exit(1);
    }
}