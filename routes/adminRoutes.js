/**
 * @file routes/adminRoutes.js
 * @description TITAN ADMIN COMMAND CENTER (GEN-6)
 * @security Level 5: Auth + Admin Check + Rate Limiting + Validation
 */

const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { adminGetShorts, adminToggleChannelShortsOnly, adminToggleVideoShort, adminDeleteShort } = require("../controllers/shortsController");

// ✅ Import Controller Functions
const {
  getRegularUsers,
  getAllAdmins,
  deleteUser,
  updateUserData,
  pushNotificationToAll,
  approveAdmin, // ✨ New Feature
  getMetricsOverview, // New Metrics Overview Endpoint
  getPaymentLogs // New Payment Logs Endpoint
} = require("../controllers/adminController");

// ✅ Import Middleware
const { isAuthenticated, isActiveUser, isAdmin, restrictTo } = require("../middleware/authMiddleware");
const validate = require("../middleware/validate"); // Import validation middleware

// ✅ Import Schemas
const { 
  userIdParamSchema, 
  adminApprovalSchema, 
  updateUserDetailsSchema, 
  notificationSchema 
} = require("../validations/adminSchema");

// ============================================================
// 🛡️ SECURITY CONFIGURATION
// ============================================================

// 🌐 PUBLIC ADMIN LOGIN ROUTES (Defined BEFORE global authentication guard)
const { adminLogin } = require("../controllers/authController");
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minutes
    max: 20, 
    message: { success: false, message: "Too many attempts. Please try again after 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});
router.post("/login", authLimiter, adminLogin);
router.post("/admin/login", authLimiter, adminLogin);

// 1. GLOBAL GUARD: Protect ALL routes in this file
router.use(isAuthenticated, isActiveUser);

// 2. SAFETY VALVE: Notification Blast Limiter
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
router.get("/users", restrictTo("SUPER_ADMIN", "ADMIN"), getRegularUsers);
router.get("/users/regular", restrictTo("SUPER_ADMIN", "ADMIN"), getRegularUsers);

// 2. Chat Alias (For Chat System Compatibility)
router.get("/chat/all", restrictTo("SUPER_ADMIN", "ADMIN"), getRegularUsers);

// 3. Get All Admins (Team Management)
router.get("/admins", restrictTo("SUPER_ADMIN", "ADMIN"), getAllAdmins);

// 4. Update User Profile (CRM)
router.patch("/users/:userId", restrictTo("SUPER_ADMIN", "ADMIN"), validate(updateUserDetailsSchema), updateUserData);

// 5. Hard Delete User (Cleanup)
router.delete("/users/:userId", restrictTo("SUPER_ADMIN", "ADMIN"), validate(userIdParamSchema), deleteUser);

// ============================================================
// 🚀 MODULE B: TITAN NOTIFICATION WAR ROOM
// ============================================================

// 1. Titan Blast: Send Push Notification to ALL Users
router.post(
    "/notifications/send-all",
    restrictTo("SUPER_ADMIN", "ADMIN"),
    blastLimiter, // 🛡️ Rate Limit Applied Here
    validate(notificationSchema), // Validate notification payload
    pushNotificationToAll
);

// 6. Approve Admin (IAM)
router.post("/approve/:adminId", restrictTo("SUPER_ADMIN", "ADMIN"), validate(adminApprovalSchema), approveAdmin);

// ============================================================
// 📊 MODULE C: ANALYTICS & REPORTING
// ============================================================

// 1. Get Metrics Overview (KPI Cards)
router.get("/metrics/overview", restrictTo("SUPER_ADMIN", "ADMIN"), getMetricsOverview);

// 2. Get Paginated Payment Logs
router.get("/payments", restrictTo("SUPER_ADMIN", "ADMIN"), getPaymentLogs);

// 3. Shorts Management (Admin Isolation)
router.get("/shorts", restrictTo("SUPER_ADMIN", "ADMIN"), adminGetShorts);
router.patch("/channels/:id/toggle-shorts-only", restrictTo("SUPER_ADMIN", "ADMIN"), adminToggleChannelShortsOnly);
router.patch("/videos/:id/toggle-short", restrictTo("SUPER_ADMIN", "ADMIN"), adminToggleVideoShort);
router.delete("/shorts/:id", restrictTo("SUPER_ADMIN", "ADMIN"), adminDeleteShort);

module.exports = router;
