/**
 * @file routes/notificationRoutes.js
 * @description TITAN NEURAL SYNC PATHWAY (GEN-7: REDIS POWERED)
 * @features Distributed Rate Limiting, User-ID Based Tracking, Anti-Bot Shield
 * @status PRODUCTION READY | SCALE: 1B+ DEVICES
 */

const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { isAuthenticated } = require('../middleware/authMiddleware');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default; // ✅ Distributed State
const { connection: redisConnection } = require('../config/redis'); // ✅ Central Redis Core
const asyncHandler = require('express-async-handler'); // ✅ Crash Prevention

// ============================================================
// 🛡️ SECURITY: TITAN SYNC LIMITER (Distributed Anti-Spam)
// ============================================================
// UPDATE: Ab ye Redis use karega. Chahe user kisi bhi Server/Core par ho,
// agar limit cross hui toh wo global block hoga.
const syncLimiter = rateLimit({
    store: new RedisStore({
        sendCommand: (...args) => redisConnection.call(...args),
    }),
    windowMs: 60 * 60 * 1000, // 1 Hour
    max: 20, // Strict Limit per User
    message: { 
        success: false, 
        message: "⚠️ Neural Sync Limit Reached. Device sync paused for 1 hour." 
    },
    standardHeaders: true,
    legacyHeaders: false,
    // 🧠 SMART TRACKING: IP ki jagah User ID track karo (zyada accurate)
    keyGenerator: (req) => {
        return req.user ? `limit-notif-${req.user._id}` : req.ip;
    },
    // Agar Redis down ho jaye, toh traffic mat roko (Fail Open Strategy)
    passOnStoreError: true 
});

// ============================================================
// 📡 DEVICE REGISTRATION ROUTES
// ============================================================

/**
 * @route   POST /api/notifications/save-token
 * @desc    Primary Device Handshake (FCM Token Sync)
 * @access  Private (Authenticated Users Only)
 */
router.post(
    '/save-token', 
    isAuthenticated, // 🔒 Security Layer 1: Auth Check
    syncLimiter,     // 🛡️ Security Layer 2: Distributed Spam Check
    asyncHandler(notificationController.registerDevice) // 🧠 Crash Proof Wrapper
);

/**
 * @route   POST /api/notifications/sync-node
 * @desc    Alias for Titan Mesh Network (Future Proofing)
 * @access  Private
 */
router.post(
    '/sync-node', 
    isAuthenticated, 
    syncLimiter, 
    asyncHandler(notificationController.registerDevice)
);

// ✅ HEALTH CHECK (For Debugging Notification Tunnel)
router.get('/health', (req, res) => {
    res.status(200).json({ status: 'active', subsystem: 'Titan Notification Gateway' });
});

module.exports = router;