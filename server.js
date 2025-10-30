require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

// --- Route Imports ---
const authRoutes = require('./routes/authRoutes');
const subscriberRoutes = require('./routes/subscriberRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ Fix “trust proxy” issue for Render
app.set('trust proxy', 1);

// ----------------------------------------------------
// ✅ CORS Setup for Render + Vercel
// ----------------------------------------------------
const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
 
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000', // for local testing
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) return callback(null, true);
      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  })
);

// ----------------------------------------------------
// 🛡️ Security & Utility Middlewares
// ----------------------------------------------------
app.use(helmet());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: 'Too many requests from this IP, please try again after 15 minutes',
  })
);
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ----------------------------------------------------
// 🌐 Root Endpoint
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.send('✅ RCM AI Production Backend is running successfully!');
});

// ----------------------------------------------------
// 🚀 Route Mounting
// ----------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api', subscriberRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/admin', adminRoutes);

// ----------------------------------------------------
// ❌ 404 Handler
// ----------------------------------------------------
app.use((req, res, next) => {
  res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// ----------------------------------------------------
// ⚠️ Global Error Handler
// ----------------------------------------------------
app.use((err, req, res, next) => {
  console.error('🔥 Global Error Handler:', err.message);
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  res.status(statusCode).json({
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});

// ----------------------------------------------------
// 🚀 Start Server
// ----------------------------------------------------
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
