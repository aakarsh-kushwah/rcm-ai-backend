// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const { db, initialize } = require('./config/db');

// --- Routes ---
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/authRoutes');
const subscriberRoutes = require('./routes/subscriberRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes');
const adminRoutes = require('./routes/adminRoutes');
const paymentRoutes = require('./routes/paymentRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Security Middlewares ---
app.set('trust proxy', 1); // Render/Heroku ke liye zaroori

// --- CORS (Cross-Origin Resource Sharing) ---
const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000', // User UI (Local)
  'http://localhost:3001',
  'http://localhost:3002', // Admin UI (Local)
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like Postman or server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      // Allow preview URLs from Render/Vercel
      if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      
      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('This origin is not allowed by CORS'), false);
    },
    credentials: true,
  })
);

// --- Global Middlewares ---
app.use(helmet()); // Basic security headers
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ⭐️ UPDATE: JSON payload size badhayi gayi (10mb)
// Profile picture Base64 string mein 5MB se badi ho sakti hai.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));


// --- Rate Limiting Setup ---
// Login/Register ke liye sakht (strict) limit
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 15 min mein 20 request
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// Baaki sabhi API ke liye normal limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500, // 15 min mein 500 request
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});


// --- API Routes ---
app.use('/', healthRoutes); // Health check
app.use('/api/auth', authLimiter, authRoutes); // Auth routes par sakht limit

// Baaki sabhi par normal limit
app.use('/api', apiLimiter, subscriberRoutes);
app.use('/api/chat', apiLimiter, chatRoutes);
app.use('/api/users', apiLimiter, userRoutes); // ✅ Yahaan /api/users register kiya gaya hai
app.use('/api/videos', apiLimiter, videoRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/payment', apiLimiter, paymentRoutes);


// --- Error Handlers ---
// 404 Route Not Found
app.use((req, res) => {
  res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('🔥 Global Error Handler:', err.message, err.stack);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});


// ============================================================
// ✅ "PRODUCTION READY" सर्वर स्टार्ट
// ============================================================
async function startServer() {
  try {
    // ⭐️ NOTE: Aapki db.js file mein pool size zaroor badhayein!
    // Example (config/db.js mein):
    // pool: { max: 20, min: 2, acquire: 30000, idle: 10000 }
    // `max: 3` 1 crore users ke liye crash ho jaayega.

    await initialize();
    console.log('✅ All models initialized:', Object.keys(db));

    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ FATAL: Failed to initialize database and start server.', error);
    process.exit(1); 
  }
}

startServer();