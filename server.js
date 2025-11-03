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
const authRoutes = require('./routes/authRoutes');
const subscriberRoutes = require('./routes/subscriberRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes');
const adminRoutes = require('./routes/adminRoutes');
const paymentRoutes = require('./routes/paymentRoutes'); // (पेमेंट रूट)

const app = express();
const PORT = process.env.PORT || 3001;

// --- Security Middlewares (सुरक्षा मिडलवेयर) ---
app.set('trust proxy', 1); // Render/Heroku के लिए ज़रूरी

const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000', // यूज़र UI (लोकल)
  'http://localhost:3001', // (यह शायद बैकएंड खुद है)
  'http://localhost:3002', // एडमिन UI (लोकल)
];

app.use(
  cors({
    origin: (origin, callback) => {
      // 1. अगर ऑरिजिन 'undefined' है (जैसे Postman), तो अलाउ करें
      if (!origin) return callback(null, true);
      // 2. अगर ऑरिजिन 'allowedOrigins' में है, तो अलाउ करें
      if (allowedOrigins.includes(origin)) return callback(null, true);
      
      // 3. Vercel/Render के प्रीव्यू URLs को अलाउ करें
      if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app'))
        return callback(null, true);
      
      // 4. बाकी सब ब्लॉक करें
      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  })
);

app.use(helmet());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- API Routes (API रूट्स) ---
app.get('/', (req, res) => {
  res.send('✅ RCM AI Production Backend is running successfully!');
});

app.use('/api/auth', authRoutes);
app.use('/api', subscriberRoutes); // ( /api/subscribe )
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes); // (पेमेंट रूट)

// --- Error Handlers (एरर हैंडलर्स) ---
app.use((req, res) => {
  res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error('🔥 Global Error Handler:', err.message);
  res.status(res.statusCode === 200 ? 500 : res.statusCode).json({
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});

// ============================================================
// ✅ "PRODUCTION READY" सर्वर स्टार्ट
// ============================================================
async function startServer() {
  try {
    // 1. पहले डेटाबेस को इनिशियलाइज़ (शुरू) करें
    await initialize();
    console.log('✅ All models initialized:', Object.keys(db));

    // 2. डेटाबेस शुरू होने के बाद ही सर्वर को सुनें
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ FATAL: Failed to initialize database and start server.', error);
    process.exit(1);
  }
}

// सर्वर को स्टार्ट करें
startServer();