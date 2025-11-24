require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const { db, initialize } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Security Middlewares ---
app.set('trust proxy', 1);

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
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  })
);

app.use(helmet()); 
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// --- Rate Limiting ---
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });

// ============================================================
// ✅ SERVER START
// ============================================================
async function startServer() {
  try {
    await initialize();
    console.log('✅ All models initialized:', Object.keys(db));

    console.log('⏳ Loading routes...');
    const healthRoutes = require('./routes/health');
    const authRoutes = require('./routes/authRoutes');
    const subscriberRoutes = require('./routes/subscriberRoutes');
    const chatRoutes = require('./routes/chatRoutes');
    const userRoutes = require('./routes/userRoutes');
    const videoRoutes = require('./routes/videoRoutes');
    const adminRoutes = require('./routes/adminRoutes');
    const paymentRoutes = require('./routes/paymentRoutes');
    
    // ✅ NEW: Import Daily Report Routes
    const dailyReportRoutes = require('./routes/dailyReportRoutes');

    console.log('✅ Routes loaded.');

    app.use('/', healthRoutes);
    app.use('/api/auth', authLimiter, authRoutes);
    app.use('/api', apiLimiter, subscriberRoutes);
    app.use('/api/chat', apiLimiter, chatRoutes);
    app.use('/api/users', apiLimiter, userRoutes);
    app.use('/api/videos', apiLimiter, videoRoutes);
    app.use('/api/admin', apiLimiter, adminRoutes);
    app.use('/api/payment', apiLimiter, paymentRoutes);
    
    // ✅ NEW: Use Daily Report Routes
    // Maps to: /api/reports/post-dailyReport
    app.use('/api/reports', apiLimiter, dailyReportRoutes);

    console.log('✅ Routes configured.');

    app.use((req, res) => {
      res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
    });

    app.use((err, req, res, next) => {
      console.error('🔥 Global Error Handler:', err.message);
      const statusCode = err.status || 500;
      res.status(statusCode).json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
      });
    });

    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('❌ FATAL: Failed to initialize database and start server.', error);
    process.exit(1);
  }
}

startServer();