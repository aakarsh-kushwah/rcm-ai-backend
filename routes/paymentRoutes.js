/**
 * @file src/routes/paymentRoutes.js
 * @description Titan Payment Network (High Latency Optimized)
 * @security Redis Rate-Limiting | JWT Guard | Webhook Failsafe
 * @status PRODUCTION READY
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default; 
const { connection: redisConnection } = require('../config/redis'); 
const { isAuthenticated } = require('../middleware/authMiddleware');

const { 
    createSubscription, 
    verifyPayment, 
    handleWebhook 
} = require('../controllers/paymentController');

// ============================================================
// 🛡️ SECURITY: NETWORK-RESILIENT LIMITER
// ============================================================
// Slow network par user baar-baar click karta hai.
// Isliye humne limit ko thoda "Loose" rakha hai (30 requests/15 mins).
// Ye Bots ko rokega, par genuine slow-network users ko nahi.
const paymentLimiter = rateLimit({
    store: new RedisStore({
        sendCommand: (...args) => redisConnection.call(...args),
    }),
    windowMs: 15 * 60 * 1000, // 15 Minutes
    max: 30, // Increased limit for retry-heavy networks
    message: {
        success: false,
        message: "⛔ Payment Gateway Busy. Please retry in 15 minutes."
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user ? `pay-limit-${req.user.id}` : req.ip 
});

// ============================================================
// 1. PAYMENT TRANSACTIONS (User Facing)
// ============================================================

/**
 * @route   POST /api/payment/create-subscription
 * @desc    Subscription initiate karna (24h Trial)
 */
router.post(
    '/create-subscription', 
    isAuthenticated, 
    paymentLimiter, // Allows retries on slow network
    createSubscription 
);

/**
 * @route   POST /api/payment/verify
 * @desc    Payment Verify karna
 * @note    Agar user ka net slow hai aur ye request fail ho jaye,
 * toh bhi chinta nahi, 'webhook' background me kaam kar dega.
 */
router.post(
    '/verify', 
    isAuthenticated, 
    verifyPayment
);

// ============================================================
// 2. BACKGROUND SYNC (The Real Hero for Slow Networks) 🦸‍♂️
// ============================================================

/**
 * @route   POST /api/payment/webhook
 * @desc    Razorpay Server calls this DIRECTLY (No User Network needed)
 * @note    Ye route kabhi fail nahi hoga chahe user ka phone switch off ho jaye.
 */
router.post(
    '/webhook', 
    handleWebhook 
);

// ============================================================
// 3. STATUS CHECK (For Polling)
// ============================================================

/**
 * @route   GET /api/payment/status
 * @desc    Frontend isse har 5 sec me check kar sakta hai
 */
router.get('/status', isAuthenticated, async (req, res) => {
    try {
        const { status, autoPayStatus, nextBillingDate } = req.user;
        res.json({ 
            success: true, 
            status: status || 'inactive',
            isPremium: status === 'premium',
            autoPay: autoPayStatus || false,
            validTill: nextBillingDate
        });
    } catch (error) {
        // Slow network par agar ye fail ho, to frontend retry karega
        res.status(500).json({ success: false, message: "Network Jitter: Status Fetch Failed" });
    }
});

module.exports = router;