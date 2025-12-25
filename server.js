/**
 * @file server.js
 * @description RCM Backend Core - Production Grade.
 * @architecture Monolithic Express with Async Micro-services (WhatsApp/AI).
 * @author Senior Architect for RCM Abhiyan
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const compression = require('compression'); 
const path = require('path'); // 👈 IMPORTED: Path module for safe file serving

// ✅ IMPORTS (Engine Components)
const { db, initialize } = require('./config/db');
const { initializeWhatsAppBot } = require('./services/whatsAppBot');

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================================
// 🛡️ SECURITY & PERFORMANCE (The Google Standard)
// ============================================================

// 1. Trust Proxy (Crucial for Cloud Hosting like Render/AWS)
app.set('trust proxy', 1);

// 2. Hide Tech Stack (Security Best Practice)
app.disable('x-powered-by'); 

// 3. Compression (Gzip - Fast Speed)
app.use(compression());

// 4. Secure Headers
// Note: We adjust Content-Security-Policy to allow Audio playback
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// 5. Smart Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// 6. Payload Limits (For Audio/Image Uploads)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================================
// 📂 STATIC ASSETS (🔥 CRITICAL FIX FOR AUDIO)
// ============================================================
// Iske bina Audio Frontend par play nahi hoga (404 Error aayega)
// Hum 'content' folder ko internet par accessible bana rahe hain.
app.use('/content', express.static(path.join(__dirname, 'content')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ============================================================
// 🌐 CORS (Access Control)
// ============================================================
const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173' // Vite Default
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow mobile apps / curl / postman
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    console.warn('⚠️ Blocked by CORS:', origin);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
}));

// ============================================================
// 🚦 RATE LIMITING (DDoS Guard)
// ============================================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minutes
  max: 2000, // Generous limit for Chat/Voice usage
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// 🚀 ROUTE REGISTRATION
// ============================================================

// 1. Health Check (Load Balancers ke liye)
app.get('/', (req, res) => res.status(200).send('RCM Neural Engine Online 🟢'));
app.use('/api/health', require('./routes/health'));

// 2. Core API Routes
app.use('/api/auth', apiLimiter, require('./routes/authRoutes'));
app.use('/api/chat', apiLimiter, require('./routes/chatRoutes'));
app.use('/api', apiLimiter, require('./routes/subscriberRoutes'));
app.use('/api/users', apiLimiter, require('./routes/userRoutes'));
app.use('/api/admin', apiLimiter, require('./routes/adminRoutes'));
app.use('/api/notifications', apiLimiter, require('./routes/notificationRoutes'));

// 3. Optional Routes (Safe Loading)
try {
    app.use('/api/reports', apiLimiter, require('./routes/dailyReportRoutes'));
    app.use('/api/videos', apiLimiter, require('./routes/videoRoutes'));
    app.use('/api/payment', apiLimiter, require('./routes/paymentRoutes'));
} catch (e) { console.warn("ℹ️ Optional Module Skipped:", e.message); }

// ============================================================
// ⚠️ ERROR HANDLING (Safety Net)
// ============================================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Endpoint Not Found: ${req.originalUrl}` });
});

// 500 Global Error Handler
app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err.message);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    // Production mein stack trace hide karna zaroori hai
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});

// ============================================================
// 🏁 IGNITION SEQUENCE
// ============================================================
async function ignite() {
  try {
    // 1. Database Connection
    console.log('⏳ Connecting to Database...');
    await initialize();
    console.log('✅ Database Synced & Ready.');

    // 2. Start HTTP Server
    const server = app.listen(PORT, () => {
      console.log(`
      ################################################
      🚀 RCM SERVER RUNNING ON PORT: ${PORT}
      🌍 Environment: ${process.env.NODE_ENV || 'development'}
      🔊 Audio Serving: /content -> Public
      ################################################
      `);
    });

    // 3. Start WhatsApp Bot (Non-Blocking)
    // Delay ensures server is stable before launching Puppeteer
    setTimeout(() => {
        try {
            console.log("🤖 Starting WhatsApp Service...");
            initializeWhatsAppBot(); 
        } catch (botError) {
            console.error("⚠️ WhatsApp Init Failed (Check Config):", botError.message);
        }
    }, 5000); 

    // 4. Graceful Shutdown (Signal Handling)
    const shutdown = () => {
      console.log('🛑 Shutting down gracefully...');
      server.close(() => {
        console.log('🛑 HTTP server closed.');
        // Force close DB
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

// 🔥 Start Engine
ignite();

// ============================================================
// 🚑 CRASH GUARD
// ============================================================
process.on('unhandledRejection', (err) => {
    console.error('💀 UNHANDLED REJECTION! Shutting down...');
    console.error(err);
    // Don't exit immediately in production, log it.
    if(process.env.NODE_ENV === 'development') process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('💀 UNCAUGHT EXCEPTION! Shutting down...');
    console.error(err);
    process.exit(1);
});