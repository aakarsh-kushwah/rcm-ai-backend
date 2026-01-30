/**
 * @file src/routes/paymentRoutes.js
 * @description Titan Payment Router
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

// Imports
const controller = require('../controllers/paymentController');
const { isAuthenticated } = require('../middleware/authMiddleware');

// 🛡️ DEBUGGING: Check if functions loaded correctly
if (!controller.createSubscription || !controller.verifyPayment || !controller.handleWebhook) {
    console.error("❌ CRITICAL ERROR: Payment Controller functions are missing!");
    console.error("Loaded Controller:", controller);
}
if (!isAuthenticated) {
    console.error("❌ CRITICAL ERROR: Auth Middleware is missing!");
}

const { createSubscription, verifyPayment, handleWebhook } = controller;

// Rate Limiter
const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: "Too many attempts. Try later." },
    standardHeaders: true,
    legacyHeaders: false,
});

// ================= Routes =================

router.post(
    '/create-subscription', 
    isAuthenticated, 
    paymentLimiter, 
    createSubscription
);

router.post(
    '/verify-payment', 
    isAuthenticated, 
    verifyPayment
);

router.post(
    '/webhook', 
    // No auth middleware here
    handleWebhook 
);

router.get('/status', isAuthenticated, async (req, res) => {
    try {
        const { status, autoPayStatus } = req.user;
        res.json({ 
            success: true, 
            status: status || 'inactive',
            isPremium: status === 'PREMIUM',
            autoPay: autoPayStatus || false
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;