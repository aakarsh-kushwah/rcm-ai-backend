/**
 * @file server.js
 * @title RCM TITAN AGI ENGINE - GEN 3
 * @description Hyper-Scale Neural Architecture (TiDB & Redis Optimized)
 * @author RCM AI Labs
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

// ✅ SYNAPTIC IMPORTS
const { connectDB } = require('./config/db'); // Ab ye TiDB (MySQL2) use karega
const { initializeWhatsAppBot } = require('./services/whatsAppBot');

// ⚙️ NEURAL CONFIGURATION
const PORT = process.env.PORT || 10000;
const TOTAL_CORES = process.env.NODE_ENV === 'production' ? os.cpus().length : 2;

// ============================================================
// 🏛️ MASTER NODE: THE HIVE MIND
// ============================================================
if (cluster.isPrimary) {
    console.clear();
    const banner = `
    ██████╗  ██████╗███╗   ███╗      █████╗ ██╗
    ██╔══██╗██╔════╝████╗ ████║     ██╔══██╗██║
    ██████╔╝██║     ██╔████╔██║     ███████║██║
    ██╔══██╗██║     ██║╚██╔╝██║     ██╔══██║██║
    ██║  ██║╚██████╗██║ ╚═╝ ██║     ██║  ██║██║
    ╚═╝  ╚═╝ ╚═════╝╚═╝     ╚═╝     ╚═╝  ╚═╝╚═╝
    
    🚀 TITAN ENGINE: AGI-READY ONLINE
    🧠 Master PID: ${process.pid}
    💻 Synaptic Cores: ${TOTAL_CORES}
    🗄️ Database: TiDB Cloud (MySQL)
    ⚡ Cache: Cloud Redis Active
    `;
    console.log(banner);

    // 🧬 Spawn Workers
    for (let i = 0; i < TOTAL_CORES; i++) {
        cluster.fork();
    }

    // ❤️ Self-Healing
    cluster.on('exit', (worker) => {
        console.warn(`⚠️ [CRITICAL] Node ${worker.process.pid} collapsed. Regenerating...`);
        cluster.fork();
    });

} else {
    // ============================================================
    // 👷 WORKER NODE: THE NERVOUS SYSTEM
    // ============================================================
    igniteNeuralPathway();
}

async function igniteNeuralPathway() {
    const app = express();

    // 1. 🚀 PERFORMANCE LAYERS
    app.set('trust proxy', 1);
    app.use(compression()); // 70% smaller payloads

    // 2. 🛡️ DEFENSE SYSTEMS (Security)
    app.disable('x-powered-by');
    app.use(helmet({
        contentSecurityPolicy: false, // UI access ke liye flexible rakha hai
    }));
    app.use(hpp());

    // 3. 🌐 CROSS-ORIGIN POLICY
    const allowedOrigins = [
        'https://rcm-ai-admin-ui.vercel.app',
        'https://rcmai.in',
        'http://localhost:3000',
        'http://localhost:5173'
    ];
    
    app.use(cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
                return callback(null, true);
            }
            return callback(new Error('🚫 Firewall: Origin Blocked'), false);
        },
        credentials: true
    }));

    // 4. 📦 PAYLOAD HANDLERS
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // 5. 🚦 TRAFFIC CONTROL (Anti-DDoS)
    const standardLimiter = rateLimit({
        windowMs: 1 * 60 * 1000, 
        max: 5000, 
        message: { error: "Neural Overload. Please wait." },
        standardHeaders: true,
    });

    // ============================================================
    // 6. 🛣️ NEURAL ROUTES
    // ============================================================
    
    // Heartbeat Check
    app.get('/', (req, res) => res.status(200).json({ 
        status: "ACTIVE", 
        engine: "TITAN Gen 3", 
        db: "TiDB", 
        node: process.pid 
    }));

    // Authentication & Core
    app.use('/api/auth', standardLimiter, require('./routes/authRoutes'));
    app.use('/api/chat', standardLimiter, require('./routes/chatRoutes'));
    app.use('/api/admin', require('./routes/adminRoutes'));
    
    // Payment & Features
    const loadModule = (path, file) => { 
        try { app.use(path, require(file)); } catch(e){ console.error(`Module ${file} not found`); } 
    };
    loadModule('/api/payment', './routes/paymentRoutes');
    loadModule('/api/notifications', './routes/notificationRoutes');

    // Error Traps
    app.use('*', (req, res) => res.status(404).json({ error: "Void Endpoint" }));
    app.use((err, req, res, next) => {
        console.error(`🔥 Node ${process.pid} Error:`, err.message);
        res.status(500).json({ error: "Internal Synapse Failure" });
    });

    // ============================================================
    // 7. 🏁 IGNITION SEQUENCE
    // ============================================================
    try {
        // 🔥 TiDB Connection Check
        await connectDB(); 

        const server = app.listen(PORT, () => {
            console.log(`⚡ Node ${process.pid} Synced on Port ${PORT}`);

            // 🤖 WORKER 1: THE COMMANDER (Bot & Queue)
            if (cluster.worker.id === 1) {
                console.log("🕵️ Special Ops: Worker 1 assigned to WhatsApp/Queues");
                setTimeout(() => {
                    if (initializeWhatsAppBot) initializeWhatsAppBot(); 
                }, 5000);
            }
        });

        // Amazon-Scale Keep-Alive
        server.keepAliveTimeout = 65000; 
        server.headersTimeout = 66000;

        // 🛑 GRACEFUL EXIT
        const shutdown = () => {
            server.close(() => {
                console.log(`✅ Node ${process.pid} Terminated Safely.`);
                process.exit(0);
            });
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

    } catch (error) {
        console.error(`❌ Critical Synapse Failure:`, error.message);
        process.exit(1);
    }
}