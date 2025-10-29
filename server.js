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
// ✅ CRITICAL FIX: CORS Must be the first middleware to handle preflight (OPTIONS) requests
// ----------------------------------------------------

const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://rcmai.in',
    'https://www.rcmai.in',
    'https://rcm-ai.vercel.app',
];

// Advanced CORS Logic with support for review branches
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
            return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Accept',
        'Origin',
        'X-Requested-With',
        'X-HTTP-Method-Override'
    ],
}));

// --- Global Security & Middleware (After CORS) ---
app.use(helmet());

// IP-based Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(apiLimiter);

// Logging for requests
app.use(morgan('combined'));

// Body Parsers: Large limits for modern apps
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- Root Test Route ---
app.get('/', (req, res) => res.send('RCM AI Production-Ready Backend is running!'));

// --- Route Mounting ---
app.use('/api/auth', authRoutes);
app.use('/api', subscriberRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/admin', adminRoutes);

// --- Global Error Handlers ---

// 404 Handler for unknown routes
app.use((req, res, next) => {
    res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// Centralized Error Handler
app.use((err, req, res, next) => {
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
});

// Start the Server
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));
