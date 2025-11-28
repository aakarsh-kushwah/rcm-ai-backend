require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const compression = require('compression'); // ✅ NEW: Speed Booster

// ✅ DB IMPORT
const { db, initialize } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// 🛡️ SECURITY & PERFORMANCE MIDDLEWARES
// ============================================================

// 1. Trust Proxy (Render/Cloudflare/AWS ke liye zaroori)
app.set('trust proxy', 1);

// 2. Compression (Response ko chhota karta hai -> Faster App)
app.use(compression());

// 3. Secure HTTP Headers
app.use(helmet());

// 4. Logging (Production mein Clean logs, Dev mein Detailed)
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// 5. Payload Size (Badi files/audio ke liye limit badhayi)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 6. CORS (Sirf apni websites ko allow karein)
const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    console.warn('❌ Blocked by CORS:', origin);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
}));

// 7. Rate Limiting (DDoS Protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minutes
  max: 50, // Thoda badhaya taaki users block na hon
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000, // Chat/Voice ke liye limit badhayi
  message: 'Server is busy, please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// 🚀 SERVER STARTUP SEQUENCE
// ============================================================
async function startServer() {
  try {
    // Step 1: Database Initialization (Critical)
    console.log('⏳ Initializing Database...');
    await initialize();
    console.log('✅ Database Connected & Models Synced.');

    // Step 2: Load Routes (Lazy Loading for Performance)
    console.log('⏳ Loading Application Routes...');
    const healthRoutes = require('./routes/health');
    const authRoutes = require('./routes/authRoutes');
    const subscriberRoutes = require('./routes/subscriberRoutes');
    const chatRoutes = require('./routes/chatRoutes');
    const userRoutes = require('./routes/userRoutes');
    const videoRoutes = require('./routes/videoRoutes');
    const adminRoutes = require('./routes/adminRoutes');
    const paymentRoutes = require('./routes/paymentRoutes');
    
    // ✅ MISSING ROUTE ADDED (Daily Reports)
    const dailyReportRoutes = require('./routes/dailyReportRoutes'); 

    // Step 3: Register Routes
    app.use('/', healthRoutes); // Health Check
    app.use('/api/auth', authLimiter, authRoutes);
    app.use('/api', apiLimiter, subscriberRoutes);
    app.use('/api/chat', apiLimiter, chatRoutes);       // Text & Voice
    app.use('/api/reports', apiLimiter, dailyReportRoutes); // ✅ Fixed: Daily Report Route
    app.use('/api/users', apiLimiter, userRoutes);
    app.use('/api/videos', apiLimiter, videoRoutes);
    app.use('/api/admin', apiLimiter, adminRoutes);
    app.use('/api/payment', apiLimiter, paymentRoutes);

    console.log('✅ All Routes Successfully Configured.');

    // Step 4: Global Error Handling (Last Middleware)
    app.use((req, res) => {
      res.status(404).json({ success: false, message: `Endpoint Not Found: ${req.originalUrl}` });
    });

    app.use((err, req, res, next) => {
      console.error('🔥 Global Error:', err.message);
      const statusCode = err.status || 500;
      res.status(statusCode).json({
        success: false,
        message: err.message || 'Internal Server Error',
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
      });
    });

    // Step 5: Ignite Server
    const server = app.listen(PORT, () => {
      console.log(`
      ################################################
      🚀 Server listening on port: ${PORT}
      🌍 Environment: ${process.env.NODE_ENV || 'development'}
      ################################################
      `);
    });

    // ============================================================
    // 🛑 GRACEFUL SHUTDOWN (Data Loss Prevention)
    // Google/Amazon servers aise hi band hote hain
    // ============================================================
    const shutdown = () => {
      console.log('🛑 SIGTERM signal received: closing HTTP server');
      server.close(() => {
        console.log('🛑 HTTP server closed');
        db.sequelize.close().then(() => {
          console.log('🛑 Database connection closed');
          process.exit(0);
        });
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    console.error('❌ FATAL: Server Startup Failed:', error);
    process.exit(1);
  }
}

// Start the engine
startServer();