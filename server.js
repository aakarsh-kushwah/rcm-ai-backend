require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet'); // Security hardening
const rateLimit = require('express-rate-limit'); // DDoS/Brute force protection
const morgan = require('morgan'); // Logging (great for production diagnostics)

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

// 2. CORS Configuration: RESTRICTED Access Control
const allowedOrigins = [
    'http://localhost:3000', // Admin UI dev environment (Example)
    'http://localhost:3002', // ✅ FIX: User UI dev environment (from your error log)
    'https://your-production-frontend.com', // Replace with your actual production domain
    'https://your-admin-frontend.com' // Replace with your Admin UI production domain
];
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, Postman, or curl)
        if (!origin) return callback(null, true); 
        
        // Check if the origin is in the allowed list
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true, // Allow cookies and authentication headers
}));

// 3. Rate Limiting: Limit repeated requests to prevent DoS attacks
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use(apiLimiter);

// 4. Logging: HTTP request logger (Use 'dev' for development/verbose logging)
app.use(morgan('dev')); 

// 5. Body Parsers: Increase limit for file/video uploads
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// --- Root Test Route ---
app.get('/', (req, res) => res.send('RCM AI Production-Ready Backend is running!'));

// --- Route Mounting ---
app.use('/api/auth', authRoutes);
app.use('/api', subscriberRoutes); 
app.use('/api/chat', chatRoutes); 
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes); // Video routes handle their own auth
app.use('/api/admin', adminRoutes); // Admin Routes Mounted

// --- Global Error Handlers ---

// 404 Handler (Catch all unhandled routes)
app.use((req, res, next) => {
    res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
});

// Centralized Error Handling Middleware (Handles errors thrown by controllers/middleware)
app.use((err, req, res, next) => {
    // Default status is 500
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode);
    res.json({
        message: err.message,
        // Only provide stack trace in development mode
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
});


app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
