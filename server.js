// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

// ✅ DB (डेटाबेस) को यहाँ इम्पोर्ट करें
const { db, initialize } = require('./config/db');

// --- Routes (रूट्स) ---
// ⭐️ NAYA: Health route ko import karein
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

// --- Security Middlewares (सुरक्षा मिडलवेयर) ---
app.set('trust proxy', 1); // Render/Heroku ke liye ज़रूरी

// --- CORS (Cross-Origin Resource Sharing) ---
// Aapka CORS config pehle se hi production-ready hai, badhiya kaam!
const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000', // यूज़र UI (लोकल)
  'http://localhost:3001',
  'http://localhost:3002', // एडमिन UI (लोकल)
];

app.use(
  cors({
    origin: (origin, callback) => {
      // !origin ka matlab Postman, Insomnia, ya server-to-server request
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      // Vercel/Render ke Preview (test) URLs ko allow karein
      if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      
      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  })
);

// --- Global Middlewares ---
app.use(helmet()); // Basic security headers lagata hai
// 'combined' log production ke liye achha hai (agar log file mein save kar rahe hain)
// Development ke liye 'dev' ka istemaal karein
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ⭐️ UPDATE: JSON payload size ko 50mb se 5mb kiya gaya
// Yeh server ko bade JSON payloads se crash hone (DoS attack) se bachata hai
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));


// --- ⭐️ "1 Crore User" Rate Limiting Setup ---
// Global rate limit hataya gaya. Ab hum har route par alag limit lagayenge.

// Login/Register jaise auth routes ke liye sakht (strict) limit
// 15 minute mein 20 request per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// Baaki API ke liye normal limit (e.g., 500 request / 15 min)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});


// --- API Routes (API रूट्स) ---

// ⭐️ UPDATE: Health route ko / par lagayein
app.use('/', healthRoutes); // ( / aur /health ke liye)

// ⭐️ UPDATE: Auth routes par sakht (authLimiter) limit lagayein
app.use('/api/auth', authLimiter, authRoutes);

// Baaki sabhi API routes par normal (apiLimiter) limit lagayein
app.use('/api', apiLimiter, subscriberRoutes);
app.use('/api/chat', apiLimiter, chatRoutes);
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api/videos', apiLimiter, videoRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/payment', apiLimiter, paymentRoutes);


// --- Error Handlers (एरर हैंडलर्स) ---
// 404 Route Not Found (Yeh hamesha saare routes ke baad aayega)
app.use((req, res) => {
  res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// Global Error Handler (Aapka pehle se hi perfect tha)
app.use((err, req, res, next) => {
  console.error('🔥 Global Error Handler:', err.message, err.stack);
  const statusCode = err.status || 500;
  res.status(statusCode).json({
    message: err.message,
    // Production mein stack trace (error details) na bhejें
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});


// ============================================================
// ✅ "PRODUCTION READY" सर्वर स्टार्ट
// =al==========================================================
// (Aapka startServer function pehle se hi best practice tha)
async function startServer() {
  try {
    // 1. Pehle database ko initialize (shuru) karein
    await initialize();
    console.log('✅ All models initialized:', Object.keys(db));

    // 2. Database shuru hone ke baad hi server ko sunein
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ FATAL: Failed to initialize database and start server.', error);
    process.exit(1); // Agar DB fail ho, toh app ko crash kar dein
  }
}

// सर्वर को स्टार्ट करें
startServer();