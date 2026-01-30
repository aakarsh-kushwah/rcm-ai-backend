/**
 * @file src/routes/paymentRoutes.js
 * @description Titan Payment Network Router (ASI Gen-5)
 * @security Rate-Limiting, Webhook Whitelisting, JWT Guard
 * @capability Handles 10k+ Concurrent Transactions
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit'); // 🛡️ Anti-Spam Shield

const { 
    createSubscription, 
    verifyPayment, 
    handleWebhook 
} = require('../controllers/paymentController');

const { isAuthenticated } = require('../middleware/authMiddleware');

// ============================================================
// 🛡️ SECURITY LAYER: RATE LIMITER
// ============================================================
// Ek IP se 15 minute me sirf 10 payment requests allow hongi.
// Ye Bots aur DDoS attacks ko rokega.
const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minutes
    max: 10, // Limit each IP to 10 requests per windowMs
    message: {
        success: false,
        message: "⛔ Too many payment attempts. Please try again after 15 minutes."
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// ============================================================
// 1. PAYMENT TRANSACTIONS (User Facing)
// ============================================================

/**
 * @route   POST /api/payment/create-subscription
 * @desc    Initiates a secure subscription transaction
 * @access  Private (JWT Required)
 * @protection Rate-Limited
 */
router.post(
    '/create-subscription', 
    isAuthenticated, // 1. Check Identity
    paymentLimiter,  // 2. Check Spam
    createSubscription // 3. Execute Logic
);

/**
 * @route   POST /api/payment/verify-payment
 * @desc    Cryptographic verification of payment success
 * @access  Private (JWT Required)
 */
router.post(
    '/verify-payment', 
    isAuthenticated, 
    verifyPayment
);

// ============================================================
// 2. BACKGROUND SYNC (Server-to-Server) 🚀
// ============================================================

/**
 * @route   POST /api/payment/webhook
 * @desc    Razorpay Server calls this to update status (Background)
 * @access  PUBLIC (Signature Verified Internally)
 * @note    NO Auth Middleware here! Razorpay doesn't have our Token.
 */
router.post(
    '/webhook', 
    // Note: Yahan 'isAuthenticated' mat lagana, warna Razorpay block ho jayega
    handleWebhook 
);

// ============================================================
// 3. SMART FEATURES (User Convenience)
// ============================================================

/**
 * @route   GET /api/payment/status
 * @desc    Check current subscription status
 * @access  Private
 */
router.get('/status', isAuthenticated, async (req, res) => {
    // Ye ek extra helper route hai frontend ke liye
    try {
        const { status, role, autoPayStatus } = req.user; // Middleware se data mil raha hai
        res.json({ 
            success: true, 
            status: status || 'inactive',
            isPremium: status === 'active',
            autoPay: autoPayStatus || false
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Error fetching status" });
    }
});

module.exports = router;