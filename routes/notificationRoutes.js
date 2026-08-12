/**
 * @file routes/notificationRoutes.js
 * @description TITAN NEURAL SYNC PATHWAY (GEN-7: REDIS POWERED)
 */

const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { isAuthenticated } = require('../middleware/authMiddleware');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('express-async-handler');

// ✅ Safe Redis Loader
let redisStore;
let redisClient;
try {
    const { connection } = require('../config/redis');
    const RedisStore = require('rate-limit-redis').default;
    redisClient = connection;
    redisStore = new RedisStore({
        sendCommand: (...args) => connection.call(...args),
    });
} catch (e) {
    console.warn("⚠️ [ROUTE WARNING]: Redis not found for Rate Limiting. Using Memory Fallback.");
}

// ============================================================
// 🛡️ SECURITY: TITAN SYNC LIMITER
// ============================================================
const syncLimiter = rateLimit({
    store: redisStore || undefined, // Fallback to MemoryStore if Redis fails
    windowMs: 60 * 60 * 1000, // 1 Hour
    max: 20,
    message: { 
        success: false, 
        message: "⚠️ Neural Sync Limit Reached. Device sync paused for 1 hour." 
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.user ? `limit-notif-${req.user._id}` : req.ip;
    },
    passOnStoreError: true 
});

// ============================================================
// 📡 ROUTES
// ============================================================

router.post(
    '/save-token', 
    isAuthenticated, 
    // isActiveUser is omitted to allow 'pending' users to register tokens
    syncLimiter,    
    asyncHandler(notificationController.registerDevice) 
);

router.post(
    '/sync-node', 
    isAuthenticated, 
    syncLimiter, 
    asyncHandler(notificationController.registerDevice)
);

router.get('/health', (req, res) => {
    res.status(200).json({ status: 'active', subsystem: 'Titan Notification Gateway' });
});

module.exports = router;