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

// ----------------------------------------------------
// ✅ FIXED: Robust and Flexible CORS for Render + Vercel
// ----------------------------------------------------
const allowedOrigins = [
  'https://rcmai.in',
  'https://www.rcmai.in',
  
  'http://localhost:3000', // for local testing
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without origin (like Postman or curl)
      if (!origin) return callback(null, true);

      // Allow known domains
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // ✅ Allow dynamic deploy preview URLs from Render or Vercel
      if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }

      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  })
);

// ----------------------------------------------------
// 🛡️ Security & Utility Middlewares
// ----------------------------------------------------

// Helmet - Security headers
app.use(helmet());

// Rate Limiting - Prevent brute force / abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(apiLimiter);

// Morgan - Request logging
app.use(morgan('combined'));

// JSON Body Parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ----------------------------------------------------
// 🌐 Root Endpoint
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.send('✅ RCM AI Production-Ready Backend is running successfully!');
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
// ❌ 404 Not Found
// ----------------------------------------------------
app.use((req, res, next) => {
  res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// ----------------------------------------------------
// ⚠️ Central Error Handler
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
app.listen(PORT, () =>
  console.log(`✅ Server is running on port ${PORT}`)
);
