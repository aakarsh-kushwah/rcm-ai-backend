require('dotenv').config();
const express = require('express');
const cors = require('cors'); // ✅ 'require' को 'cors' से ठीक किया गया
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
// सुनिश्चित करें कि यह फ़ाइल मौजूद है और उसमें 'db' और 'initialize' एक्सपोर्ट होते हैं
const { db, initialize } = require('./config/db'); 

// Routes (यह सुनिश्चित करें कि ये फ़ाइलें routes फ़ोल्डर में मौजूद हैं)
const authRoutes = require('./routes/authRoutes');
const subscriberRoutes = require('./routes/subscriberRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userRoutes = require('./routes/userRoutes');
const videoRoutes = require('./routes/videoRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

// --- 🛡️ सिक्योरिटी और परफॉर्मेंस सेटिंग्स ---

app.set('trust proxy', 1); // रेट लिमिटर के लिए आवश्यक

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
            if (allowedOrigins.includes(origin) || origin.endsWith('.onrender.com') || origin.endsWith('.vercel.app')) {
                return callback(null, true);
            }
            console.warn('❌ Blocked by CORS:', origin);
            return callback(new Error('Not allowed by CORS'), false);
        },
        credentials: true,
    })
);

app.use(helmet()); // 11 अलग-अलग HTTP हेडर सेट करके सुरक्षा बढ़ाता है
app.use(rateLimit({ 
    windowMs: 15 * 60 * 1000, // 15 मिनट
    max: 1000, // प्रत्येक IP को प्रति विंडो 1000 अनुरोधों तक सीमित करें
    message: "Too many requests from this IP, please try again after 15 minutes."
}));
app.use(morgan('combined')); // बेहतर लॉगिंग
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- 🛣️ रूट डेफिनेशन्स ---

app.get('/', (req, res) => {
    res.send('✅ RCM AI Production Backend is running successfully!');
});

app.use('/api/auth', authRoutes);
app.use('/api', subscriberRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/admin', adminRoutes);

// --- ⚠️ एरर हैंडलिंग ---

// 404 Handler
app.use((req, res, next) => {
    const error = new Error(`Route Not Found: ${req.originalUrl}`);
    error.status = 404;
    next(error);
});

// Global Error Handler
app.use((err, req, res, next) => {
    // अगर हेडर पहले ही भेजे जा चुके हैं, तो Express के डिफ़ॉल्ट एरर हैंडलर का उपयोग करें
    if (res.headersSent) {
        return next(err);
    }
    const statusCode = err.status || 500;
    
    // केवल डेवलपमेंट में Stacktrace दिखाएं
    const stack = process.env.NODE_ENV === 'production' ? null : err.stack;
    
    console.error(`🔥 [${statusCode}] Global Error Handler:`, err.message, stack);
    
    res.status(statusCode).json({
        success: false,
        message: err.message || 'Internal Server Error',
        stack: stack,
    });
});

// --- 🚀 सर्वर स्टार्ट लॉजिक ---

initialize()
    .then(() => {
        // यह सुनिश्चित करता है कि DB और मॉडल्स पूरी तरह से लोड हों
        console.log('✅ All Sequelize models initialized and synced.'); 
        app.listen(PORT, () => {
            console.log(`✅ Server running successfully on port ${PORT} in ${process.env.NODE_ENV} mode.`);
        });
    })
    .catch((error) => {
        console.error('❌ FATAL: Failed to initialize database and start server.', error);
        // गंभीर त्रुटि होने पर प्रोसेस को समाप्त करें
        process.exit(1); 
    });