/**
 * @file server.js
 * @title RCM TITAN AGI ENGINE - GEN 3
 * @description Hyper-Scale Neural Architecture for AGI/ASI Systems
 * @architecture Master-Worker Hive | Redis Event Bus | Self-Healing
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
const path = require('path');
const { createBullBoard } = require('@bull-board/api'); // Optional: For visualizing queues
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

// ✅ SYNAPTIC IMPORTS (Internal Layers)
const { connectDB, db } = require('./config/db');
const { initializeWhatsAppBot } = require('./services/whatsAppBot'); // Updated Queue Version

// ⚙️ NEURAL CONFIGURATION
const PORT = process.env.PORT || 10000;
// Production me saare CPU cores use honge, Dev me sirf 2
const TOTAL_CORES = process.env.NODE_ENV === 'production' ? os.cpus().length : 2;

// ============================================================
// 🏛️ MASTER NODE (THE HIVE MIND)
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
    
    🚀 TITAN ENGINE: AGI-READY ARCHITECTURE
    🧠 Master PID: ${process.pid}
    💻 Synaptic Cores: ${TOTAL_CORES}
    🛡️ Defense Systems: ACTIVE
    `;
    console.log(banner);

    // 🧬 Spawn Workers (Clone Process)
    for (let i = 0; i < TOTAL_CORES; i++) {
        cluster.fork();
    }

    // ❤️ Self-Healing Protocol
    cluster.on('exit', (worker, code, signal) => {
        console.warn(`⚠️ [CRITICAL] Node ${worker.process.pid} died. Initiating Regeneration...`);
        cluster.fork(); // Turant naya worker paida karo
    });

} else {
    // ============================================================
    // 👷 WORKER NODE (THE NERVOUS SYSTEM)
    // ============================================================
    igniteNeuralPathway();
}

async function igniteNeuralPathway() {
    const app = express();

    // 1. 🚀 HYPER-SPEED OPTIMIZATIONS
    app.set('trust proxy', 1); // For AWS/Vercel Load Balancers
    app.use(compression());    // Gzip Compression (Reduces payload by 70%)

    // 2. 🛡️ MILITARY-GRADE SECURITY
    app.disable('x-powered-by'); 
    app.use(helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                mediaSrc: ["'self'", "https://res.cloudinary.com", "blob:", "data:"],
                imgSrc: ["'self'", "https://res.cloudinary.com", "data:", "blob:"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                connectSrc: ["'self'", "ws:", "wss:"], // WebSockets allowed
            },
        },
    }));
    app.use(hpp()); // HTTP Parameter Pollution Shield

    // 3. 🌐 UNIVERSAL CORS (Allowed Origins)
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
            return callback(new Error('🚫 Firewall blocked this origin'), false);
        },
        credentials: true
    }));

    // 4. 📦 DATA INGESTION (High Capacity)
    app.use(express.json({ limit: '100mb' })); 
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));

    // 5. 🚦 INTELLIGENT TRAFFIC CONTROL (DDoS Protection)
    const standardLimiter = rateLimit({
        windowMs: 1 * 60 * 1000, 
        max: 5000, // 5000 req/min (Amazon Scale)
        message: { error: "Traffic Limit Exceeded. Cooling down..." },
        standardHeaders: true,
    });

    // ============================================================
    // 7. 🛣️ NEURAL ROUTES
    // ============================================================
    
    // Heartbeat
    app.get('/', (req, res) => res.status(200).json({ status: "ONLINE", node: process.pid, load: os.loadavg() }));
    app.use('/api/health', require('./routes/health'));

    // Core Logic
    app.use('/api/auth', standardLimiter, require('./routes/authRoutes'));
    app.use('/api/chat', standardLimiter, require('./routes/chatRoutes'));
    app.use('/api/admin', require('./routes/adminRoutes')); // No limit for admin
    
    // Optional Modules (Safe Load)
    const loadModule = (path, file) => { try { app.use(path, require(file)); } catch(e){} };
    loadModule('/api/payment', './routes/paymentRoutes');
    loadModule('/api/notifications', './routes/notificationRoutes');

    // 404 & Global Error Trap
    app.use('*', (req, res) => res.status(404).json({ error: "Void Endpoint Detected" }));
    app.use((err, req, res, next) => {
        console.error(`🔥 [Node ${process.pid} Error]:`, err.message);
        res.status(500).json({ error: "Internal Synapse Failure", details: err.message });
    });

    // ============================================================
    // 8. 🏁 IGNITION SEQUENCE
    // ============================================================
    try {
        await connectDB(); // Database Link

        const server = app.listen(PORT, () => {
            console.log(`⚡ Node ${process.pid} Active on PORT ${PORT}`);

            // 🤖 SPECIALIZED WORKER ASSIGNMENT
            // Worker 1 = The Communications Officer (WhatsApp + Queue Processor)
            // Workers 2,3,4... = The API Handlers (Fast Response)
            
            if (cluster.worker.id === 1) {
                console.log("\n🕵️ [SPECIAL OPS] Worker 1 Assigned to WhatsApp & Queue Processing");
                console.log("---------------------------------------------------------------");
                
                // Thoda delay taaki DB/Redis stable ho jaye
                setTimeout(() => {
                    initializeWhatsAppBot(); 
                }, 3000);
            }
        });

        // 🛠️ Keep-Alive Optimization (Fixes 502 Bad Gateway on AWS/Nginx)
        server.keepAliveTimeout = 65000; 
        server.headersTimeout = 66000;

        // 🛑 GRACEFUL SHUTDOWN (Zero Data Loss)
        const shutdown = () => {
            console.log(`🛑 Node ${process.pid} shutting down gracefully...`);
            server.close(() => {
                console.log('✅ Server Closed.');
                // Database aur Redis connections yahan close kar sakte hain
                process.exit(0);
            });
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

    } catch (error) {
        console.error(`❌ Critical Failure on Node ${process.pid}:`, error);
        process.exit(1);
    }
}