require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const { db, initialize } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3001;

// Required for Render/Heroku
app.set('trust proxy', 1);

// ============================================================
// ⭐ FINAL CORS CONFIG — 403 Problem Fully Fixed
// ============================================================
const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000', 
  'http://localhost:3001',
  'http://localhost:3002',
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server / Postman / curl (origin null case)
      if (!origin) return callback(null, true);

      // Allow known UIs
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Allow Vercel/Render preview deployments
      if (origin.endsWith(".onrender.com") || origin.endsWith(".vercel.app")) {
        return callback(null, true);
      }

      // Block unknown origins
      console.warn("❌ Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
  })
);

// ============================================================
// Global Middlewares
// ============================================================
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ============================================================
// Rate Limiting
// ============================================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many login attempts. Try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many API requests from this IP. Try later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// START SERVER
// ============================================================
async function startServer() {
  try {
    // 1. Initialize DB first
    await initialize();
    console.log('✅ Database initialized:', Object.keys(db));

    // 2. Load routes AFTER DB is ready
    console.log('⏳ Loading routes...');
    const healthRoutes = require('./routes/health');
    const authRoutes = require('./routes/authRoutes');
    const subscriberRoutes = require('./routes/subscriberRoutes');
    const chatRoutes = require('./routes/chatRoutes');
    const userRoutes = require('./routes/userRoutes');
    const videoRoutes = require('./routes/videoRoutes');
    const adminRoutes = require('./routes/adminRoutes');
    const paymentRoutes = require('./routes/paymentRoutes');
    console.log('✅ Routes loaded');

    // 3. Apply routes
    app.use('/', healthRoutes); 
    app.use('/api/auth', authLimiter, authRoutes);
    app.use('/api', apiLimiter, subscriberRoutes);
    app.use('/api/chat', apiLimiter, chatRoutes);
    app.use('/api/users', apiLimiter, userRoutes);
    app.use('/api/videos', apiLimiter, videoRoutes);
    app.use('/api/admin', apiLimiter, adminRoutes);
    app.use('/api/payment', apiLimiter, paymentRoutes);

    // ============================================================
    // 404 Handler
    // ============================================================
    app.use((req, res) => {
      res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
    });

    // ============================================================
    // Global Error Handler
    // ============================================================
    app.use((err, req, res, next) => {
      console.error('🔥 Global Error:', err.message);
      res.status(err.status || 500).json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
      });
    });

    // 5. Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('❌ FATAL ERROR: Cannot start server:', error);
    process.exit(1);
  }
}

startServer();
