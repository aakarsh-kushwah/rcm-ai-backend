/**
 * @file routes/adminRoutes.js
 * @description TITAN ADMIN COMMAND CENTER (GEN-6)
 * @security Level 5: Auth + Admin Check + Rate Limiting + Validation
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

// ✅ Import Controller Functions
const { 
  getRegularUsers, 
  getAllAdmins,
  deleteUser,
  updateUserData,
  pushNotificationToAll // ✨ New ASI Feature
} = require('../controllers/adminController');

// ✅ Import Middleware
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');

// ============================================================
// 🛡️ SECURITY CONFIGURATION
// ============================================================

// 1. GLOBAL GUARD: Protect ALL routes in this file
// Koi bhi bina login ya bina Admin role ke is file ko touch nahi kar sakta.
router.use(isAuthenticated, isAdmin);

// 2. SAFETY VALVE: Notification Blast Limiter
// Rule: 15 minute me sirf 5 baar 'Mass Notification' allowed hai.
const blastLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minutes
    max: 5, // Limit
    message: { 
        success: false, 
        message: "⚠️ Titan Cooling Down: Broadcast limit reached. Try again in 15 mins." 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ============================================================
// 👥 MODULE A: USER MANAGEMENT OPS
// ============================================================

// 1. Get Regular Users (Dashboard Data)
// URL: GET /api/admin/users/regular
router.get('/users/regular', getRegularUsers);

// 2. Chat Alias (For Chat System Compatibility)
// URL: GET /api/admin/chat/all
router.get('/chat/all', getRegularUsers);

// 3. Get All Admins (Team Management)
// URL: GET /api/admin/admins
router.get('/admins', getAllAdmins);

// 4. Update User Profile (CRM)
// URL: PATCH /api/admin/users/:userId
router.patch('/users/:userId', updateUserData);

// 5. Hard Delete User (Cleanup)
// URL: DELETE /api/admin/users/:userId
router.delete('/users/:userId', deleteUser);

// ============================================================
// 🚀 MODULE B: TITAN NOTIFICATION WAR ROOM
// ============================================================

// 1. Titan Blast: Send Push Notification to ALL Users
// Features: Parallel Batching, Rich Media, Deep Linking
// URL: POST /api/admin/notifications/send-all
router.post(
    '/notifications/send-all', 
    blastLimiter, // 🛡️ Rate Limit Applied Here
    pushNotificationToAll
);

module.exports = router;