require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // Security hardening
const rateLimit = require('express-rate-limit'); // DDoS/Brute force protection
const morgan = require('morgan'); // Logging

// --- Route Imports ---
const authRoutes = require('./routes/authRoutes');
const subscriberRoutes = require('./routes/subscriberRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes'); 
const adminRoutes = require('./routes/adminRoutes'); 

const app = express();
const PORT = process.env.PORT || 3001;

// --- Global Security & Middleware ---

// 1. Helmet: Secure Express apps by setting various HTTP headers
app.use(helmet());

// 2. CORS Configuration: Allows local host and Vercel production domains
const allowedOrigins = [
'http://localhost:3000', 
    'http://localhost:3002', 
    'https://rcmai.in', 
    'https://www.rcmai.in', // ✅ CRITICAL FIX: Added the live custom domain
    // Add your live Vercel domains here for production access
    'https://your-vercel-frontend.vercel.app', 
    'https://your-admin-frontend.vercel.app',
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Check for dynamic Render/Vercel URLs (for review branches, etc.)
        if (origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
            return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
}));

// 3. Rate Limiting: Limit repeated requests
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, 
    message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use(apiLimiter);

// 4. Logging: HTTP request logger
app.use(morgan('combined')); 

// 5. Body Parsers: Increased limit for safety
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
app.use('/api/admin', adminRoutes); // Admin Routes Mounted

// --- Global Error Handlers ---

// 404 Handler (Catch all unhandled routes)
app.use((req, res, next) => {
    res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode);
    res.json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
});


app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
