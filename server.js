require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

// ✅ DB (डेटाबेस) ko yahaan IMPORT karein
const { db, initialize } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Security Middlewares (सुरक्षा मिडलवेयर) ---
app.set('trust proxy', 1); 

// --- CORS (Cross-Origin Resource Sharing) ---
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

// --- Global Middlewares ---
app.use(helmet()); 
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));


// --- ⭐️ "1 Crore User" Rate Limiting Setup (Unchanged) ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});


// ============================================================
// ✅ "PRODUCTION READY" सर्वर स्टार्ट
// ============================================================
async function startServer() {
  try {
    // 1. Pehle database ko initialize (shuru) karein
    // ismein db.js se naye models (YoutubeChannel, YoutubeVideo) aur unke associations load honge
    await initialize();
    console.log('✅ All models initialized:', Object.keys(db));

    // 2. ⭐️ DATABASE READY HONE KE BAAD HI ROUTES KO IMPORT KAREIN
    console.log('⏳ Loading routes...');
    const healthRoutes = require('./routes/health');
    const authRoutes = require('./routes/authRoutes');
    const subscriberRoutes = require('./routes/subscriberRoutes');
    const chatRoutes = require('./routes/chatRoutes');
    const userRoutes = require('./routes/userRoutes');
    
    // ✅ YAHAN VIDEO ROUTES IMPORT KIYA JA RAHA HAI
    const videoRoutes = require('./routes/videoRoutes'); 
    
    const adminRoutes = require('./routes/adminRoutes');
    const paymentRoutes = require('./routes/paymentRoutes');
    console.log('✅ Routes loaded.');

    // 3. ⭐️ AB ROUTES KA ISTEMAAL KAREIN
    app.use('/', healthRoutes); 
    app.use('/api/auth', authLimiter, authRoutes);
    app.use('/api', apiLimiter, subscriberRoutes);
    app.use('/api/chat', apiLimiter, chatRoutes);
    app.use('/api/users', apiLimiter, userRoutes);
    
    // ✅ NAYE YOUTUBE ROUTES AB /api/videos/ KE ANDAR AVAILABLE HAIN
    app.use('/api/videos', apiLimiter, videoRoutes); 
    
    app.use('/api/admin', apiLimiter, adminRoutes);
    app.use('/api/payment', apiLimiter, paymentRoutes);
    console.log('✅ Routes configured.');

    // --- Error Handlers (एरर हैंडलर्स) ---
    // 4. SABHI ROUTES KE BAAD error handlers ko setup karein
    app.use((req, res) => {
      res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
    });

    app.use((err, req, res, next) => {
      console.error('🔥 Global Error Handler:', err.message, err.stack);
      const statusCode = err.status || 500;
      res.status(statusCode).json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
      });
    });

    // 5. Database shuru hone ke baad hi server ko sunein
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