/**
 * @file server.js
 * @description RCM Backend Core - Enterprise Production Grade.
 * @architecture Monolithic Express with Async Micro-services (WhatsApp/AI).
 * @optimization High Concurrency Support for Render Free Tier + TiDB.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const compression = require('compression'); 
const path = require('path'); 

// ✅ INTERNAL ENGINE IMPORTS
const { db, initialize } = require('./config/db');
const { initializeWhatsAppBot } = require('./services/whatsAppBot');

// ✅ INITIALIZE APP
const app = express();
const PORT = process.env.PORT || 10000;

// ============================================================
// 1. 🚀 PERFORMANCE & PROXY SETTINGS (Critical for Render)
// ============================================================

// Render/AWS Load Balancers ke peeche real IP pane ke liye zaroori hai
app.set('trust proxy', 1);

// Gzip Compression: Response size ko 70% tak kam kar deta hai (Speed Booster)
app.use(compression()); 

// ============================================================
// 2. 🛡️ SECURITY LAYER (Helmet & Headers)
// ============================================================

// Hide "Express" from hackers
app.disable('x-powered-by'); 

// Advanced Header Security
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Audio/Images load hone deta hai
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            mediaSrc: ["'self'", "https://res.cloudinary.com", "blob:", "data:"], // ✅ Audio Play Fix
            imgSrc: ["'self'", "https://res.cloudinary.com", "data:", "blob:"],
            scriptSrc: ["'self'", "'unsafe-inline'"], 
        },
    },
}));

// ============================================================
// 3. 🌐 CORS (Access Control Manager)
// ============================================================
const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    // Mobile Apps / Postman (No Origin) allowed
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    console.warn(`⚠️ CORS Blocked: ${origin}`);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
}));

// ============================================================
// 4. 📦 PARSERS & LOGGING
// ============================================================

// Request Logging (Production me clean logs, Dev me detailed)
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body Parsers (Audio/Image Uploads ke liye limit badhai hai)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================================
// 5. 📂 STATIC ASSETS SERVING (Audio Engine)
// ============================================================
// Iske bina Generated Audio frontend par play nahi hoga (404 Error aayega)
app.use('/content', express.static(path.join(__dirname, 'content')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ============================================================
// 6. 🚦 RATE LIMITING (DDoS Protection)
// ============================================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minutes
  max: 3000, // Thoda badhaya hai taaki high traffic me legit user block na ho
  message: { success: false, message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// 7. 🛣️ API ROUTES
// ============================================================

// 🟢 Uptime Robot / Health Check (Keep Server Alive)
app.get('/', (req, res) => res.status(200).send('RCM Neural Engine Online 🟢'));
app.use('/api/health', require('./routes/health'));

// Core Business Routes
app.use('/api/auth', apiLimiter, require('./routes/authRoutes'));
app.use('/api/chat', apiLimiter, require('./routes/chatRoutes')); // ✅ Updated Chat Logic Linked
app.use('/api/users', apiLimiter, require('./routes/userRoutes'));
app.use('/api/admin', apiLimiter, require('./routes/adminRoutes'));
app.use('/api/notifications', apiLimiter, require('./routes/notificationRoutes'));
app.use('/api/subscribers', apiLimiter, require('./routes/subscriberRoutes')); // Naming fixed

// Optional Modules (Fail-safe Loading)
const loadRoute = (path, routeFile) => {
    try { app.use(path, apiLimiter, require(routeFile)); } 
    catch (e) { console.warn(`ℹ️ Module skipped: ${path} (${e.message})`); }
};

loadRoute('/api/reports', './routes/dailyReportRoutes');
loadRoute('/api/videos', './routes/videoRoutes');
loadRoute('/api/payment', './routes/paymentRoutes');

// ============================================================
// 8. ⚠️ GLOBAL ERROR HANDLING
// ============================================================

// 404 - Not Found
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Endpoint Not Found: ${req.originalUrl}` });
});

// 500 - Server Error
app.use((err, req, res, next) => {
  console.error('🔥 Fatal Server Error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined // Hide stack in prod
  });
});

// ============================================================
// 9. 🏁 ENGINE IGNITION SEQUENCE
// ============================================================
async function ignite() {
  try {
    console.log('⏳ Initializing RCM Core Systems...');

    // 1. Connect to TiDB Database
    await initialize(); 
    console.log('✅ Database Connection: STABLE');

    // 2. Start HTTP Server
    const server = app.listen(PORT, () => {
      console.log(`
      ################################################
      🚀 RCM SERVER RUNNING ON PORT: ${PORT}
      🌍 Environment: ${process.env.NODE_ENV || 'development'}
      ⚡ Compression: ENABLED
      🔊 Audio Serving: /content -> Public
      ################################################
      `);
    });

    // 3. Start WhatsApp Bot (Non-Blocking / Async)
    // 5 second delay taaki server pehle stable ho jaye
    setTimeout(() => {
        try {
            console.log("🤖 Initializing WhatsApp Service...");
            initializeWhatsAppBot(); 
        } catch (botError) {
            console.error("⚠️ WhatsApp Bot Init Failed:", botError.message);
        }
    }, 5000);

    // 4. Graceful Shutdown (Data Integrity)
    const shutdown = () => {
      console.log('\n🛑 Shutting down gracefully...');
      server.close(() => {
        console.log('🛑 HTTP server closed.');
        if (db && db.sequelize) {
            db.sequelize.close().then(() => {
                console.log('🛑 Database connection closed.');
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    console.error('❌ FATAL STARTUP ERROR:', error);
    process.exit(1);
  }
}

// 🔥 Start the Engine
ignite();

// ============================================================
// 🚑 CRASH GUARDS (Prevents Downtime)
// ============================================================
process.on('unhandledRejection', (err) => {
    console.error('💀 UNHANDLED REJECTION:', err.message);
    // Keep running in production, log critical error
});

process.on('uncaughtException', (err) => {
    console.error('💀 UNCAUGHT EXCEPTION:', err.message);
    process.exit(1); // Force restart for clean state
});