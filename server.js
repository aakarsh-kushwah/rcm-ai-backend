/**
 * @file server.js
 * @title RCM TITAN AGI ENGINE - GEN 3 (Optimized)
 * @description Hyper-Scale Neural Architecture for Render/Cloud Environments
 * @author RCM AI Labs
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { Queue } = require('bullmq');

// ✅ SYNAPTIC IMPORTS
const { connectDB } = require('./config/db');
const connection = require('./config/redis'); // Central Redis
const { initializeWhatsAppBot } = require('./services/whatsAppBot');

// ⚙️ NEURAL CONFIGURATION
const PORT = process.env.PORT || 10000;

// ============================================================
// 🏛️ CORE ENGINE INITIALIZATION
// ============================================================
async function igniteNeuralPathway() {
    const app = express();

    // 1. 🚀 HYPER-SPEED OPTIMIZATIONS
    app.set('trust proxy', 1); 
    app.use(compression());    

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
                connectSrc: ["'self'", "ws:", "wss:"],
            },
        },
    }));
    app.use(hpp()); 

    // 3. 🌐 UNIVERSAL CORS (Professional Handling)
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

    // 4. 📦 DATA INGESTION
    app.use(express.json({ limit: '50mb' })); 
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // 5. 🚦 TRAFFIC CONTROL (DDoS Protection)
    const standardLimiter = rateLimit({
        windowMs: 1 * 60 * 1000, 
        max: 1000, 
        message: { error: "Traffic Limit Exceeded." },
        standardHeaders: true,
    });

    // ============================================================
    // 🏛️ NEURAL ROUTES
    // ============================================================
    const banner = `
    ██████╗  ██████╗███╗   ███╗      █████╗ ██╗
    ██╔══██╗██╔════╝████╗ ████║     ██╔══██╗██║
    ██████╔╝██║     ██╔████╔██║     ███████║██║
    ██╔══██╗██║     ██║╚██╔╝██║     ██╔══██║██║
    ██║  ██║╚██████╗██║ ╚═╝ ██║     ██║  ██║██║
    ╚═╝  ╚═╝ ╚═════╝╚═╝     ╚═╝     ╚═╝  ╚═╝╚═╝
    🚀 TITAN ENGINE: AGI-READY ONLINE
    `;
    console.log(banner);

    // Heartbeat
    app.get('/', (req, res) => res.status(200).json({ status: "ONLINE", engine: "Titan Gen-3" }));
    
    // API Mapping
    app.use('/api/auth', standardLimiter, require('./routes/authRoutes'));
    app.use('/api/admin', require('./routes/adminRoutes'));

    // 404 & Error Trap
    app.use('*', (req, res) => res.status(404).json({ error: "Void Endpoint" }));
    app.use((err, req, res, next) => {
        console.error(`🔥 [System Error]:`, err.message);
        res.status(500).json({ error: "Internal Failure", details: err.message });
    });

    // ============================================================
    // 🚀 IGNITION
    // ============================================================
    try {
        // A. Connect Database
        await connectDB();
        console.log('✅ MySQL Connectivity: Established');

        // B. Connect Redis
        connection.on('ready', () => console.log('✅ Redis Event Bus: Online'));

        // C. Initialize WhatsApp (Baileys Engine)
        // Memory optimize karne ke liye hum ise yahan se call karte hain
        initializeWhatsAppBot();

        // D. Start Server
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`⚡ Titan Engine listening on Port ${PORT}`);
        });

        // E. Keep-Alive Fix
        server.keepAliveTimeout = 65000;
        server.headersTimeout = 66000;

        // F. Graceful Shutdown
        const shutdown = () => {
            console.log('🛑 Initiating Graceful Shutdown...');
            server.close(() => {
                console.log('✅ All connections closed. System Offline.');
                process.exit(0);
            });
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

    } catch (error) {
        console.error(`❌ Critical System Failure:`, error);
        process.exit(1);
    }
}

igniteNeuralPathway();