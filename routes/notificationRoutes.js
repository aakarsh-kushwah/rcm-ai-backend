/**
 * @file routes/notificationRoutes.js
 * @description TITAN NEURAL SYNC PATHWAY (GEN-6)
 * @features Anti-Bot Security, Device Fingerprinting Support
 */

const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { isAuthenticated } = require('../middleware/authMiddleware');
const rateLimit = require('express-rate-limit');

// ============================================================
// 🛡️ SECURITY: SYNC LIMITER (Anti-Spam)
// ============================================================
// Rule: Ek IP se 1 ghante me max 20 baar token update allow karenge.
// Ye DB ko overload hone se bachata hai.
const syncLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 Hour
    max: 20, // Limit per IP
    message: { 
        success: false, 
        message: "⚠️ Neural Sync Limit Reached. Slow down." 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ============================================================
// 📡 DEVICE REGISTRATION ROUTES
// ============================================================

// 1. Register/Update Device Token (Main Endpoint)
// Frontend is route par hit karega jab user login karega.
// URL: POST /api/notifications/save-token
router.post(
    '/save-token', 
    isAuthenticated, // 🔒 Pehle login check karo
    syncLimiter,     // 🛡️ Phir spam check karo
    notificationController.registerDevice // 🧠 Phir Titan Logic chalao
);

// 2. Alias for "Titan" Naming Convention (Optional/Future Proof)
// URL: POST /api/notifications/sync-node
router.post(
    '/sync-node', 
    isAuthenticated, 
    syncLimiter, 
    notificationController.registerDevice
);

module.exports = router;