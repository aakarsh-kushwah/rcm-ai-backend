require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const { db, initialize } = require('./config/db');

// Routes
const authRoutes = require('./routes/authRoutes');
const subscriberRoutes = require('./routes/subscriberRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

const allowedOrigins = [
  'https://rcm-ai-admin-ui.vercel.app',
  'https://rcm-ai-frontend.vercel.app',
  'https://rcmai.in',
  'https://www.rcmai.in',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002'
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app'))
        return callback(null, true);
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

app.get('/', (req, res) => {
  res.send('✅ RCM AI Production Backend is running successfully!');
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', subscriberRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/admin', adminRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('🔥 Global Error Handler:', err.message);
  res.status(res.statusCode === 200 ? 500 : res.statusCode).json({
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});

// Start Server
initialize()
  .then(() => {
    console.log('✅ All models initialized:', Object.keys(db));
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ Failed to initialize database:', error);
    process.exit(1);
  });
