/**
 * @file routes/notificationRoutes.js
 * @description Enterprise-grade Notification Gateway.
 * - Multi-alias device registration (supports /save-token, /register-device, /register-token, /sync-node)
 * - Redis-backed rate limiting with graceful in-memory fallback
 * - Secure admin broadcast & delivery tracking
 */

const express = require("express");
const router = express.Router();
const asyncHandler = require("express-async-handler");

const notificationController = require("../controllers/notificationController");
const { isAuthenticated, isActiveUser, restrictTo } = require("../middleware/authMiddleware");
const { createLimiter, userKeyGenerator } = require("../middleware/rateLimiter");

// Admin permission guard (Super Admin & Admin roles with active status)
const ADMIN_ONLY = [isAuthenticated, isActiveUser, restrictTo("SUPER_ADMIN", "ADMIN")];

// Device sync rate limiter (60 sync requests per hour to avoid blocking frequent logins/switches)
const syncLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 60,
    prefix: "rl:notif-sync:",
    keyGenerator: (req) => (req.user && req.user.id ? String(req.user.id) : req.ip),
    message: "Device sync limit reached. Please try again in an hour.",
});

// Admin broadcast rate limiter (20 bulk campaigns per hour)
const broadcastLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    prefix: "rl:notif-send:",
    keyGenerator: userKeyGenerator,
    message: "Broadcast limit reached (20 per hour).",
});

// ============================================================================
// 📱 DEVICE TOKEN REGISTRATION (Multi-Alias Routes to avoid 404s)
// ============================================================================
// Supports frontend usePushNotification hook and background service workers
router.post("/save-token", isAuthenticated, syncLimiter, asyncHandler(notificationController.registerDevice));
router.post("/register-device", isAuthenticated, syncLimiter, asyncHandler(notificationController.registerDevice));
router.post("/register-token", isAuthenticated, syncLimiter, asyncHandler(notificationController.registerDevice));
router.post("/sync-node", isAuthenticated, syncLimiter, asyncHandler(notificationController.registerDevice));

// ============================================================================
// 🔕 DASHBOARD BELL TOGGLE OFF / UNREGISTER
// ============================================================================
router.post("/unsubscribe", isAuthenticated, syncLimiter, asyncHandler(notificationController.unregisterDevice));
router.post("/unregister-device", isAuthenticated, syncLimiter, asyncHandler(notificationController.unregisterDevice));

// ============================================================================
// 📢 ADMIN BROADCAST & TELEMETRY
// ============================================================================
router.post("/send", ...ADMIN_ONLY, broadcastLimiter, asyncHandler(notificationController.sendTitanBroadcast));
router.get("/send/:jobId/status", ...ADMIN_ONLY, asyncHandler(notificationController.getBroadcastStatus));

// ============================================================================
// 🩺 GATEWAY HEALTH CHECKS
// ============================================================================
router.get("/send/health", (req, res) => {
    res.status(200).json({ 
        status: "active", 
        subsystem: "Notification Gateway - Send Endpoint",
        timestamp: new Date().toISOString()
    });
});

router.get("/test-health", (req, res) => {
    res.status(200).json({ 
        status: "active", 
        subsystem: "Notification Gateway - Test Health",
        timestamp: new Date().toISOString()
    });
});

module.exports = router;