const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { googleAuthLogin, adminSignup, adminVerify, refreshToken, adminGooglePhaseOne, adminMasterPasswordPhaseTwo } = require("../controllers/authController");
const validate = require("../middleware/validate");
const { adminSignupSchema, adminVerifySchema } = require("../validations/adminSchema");

// 🛡️ SECURITY: Rate Limiter (Brute Force Protection)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minutes
    max: 20, 
    message: { success: false, message: "Too many attempts. Please try again after 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Specific rate limiter for Google Auth
const googleAuthLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 Minute
    max: 10,
    message: { success: false, message: "Too many Google login attempts. Please try again shortly." },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * @route   POST /api/auth/google
 * @desc    Google OAuth Authentication & Onboarding
 * @access  Public
 */
router.post("/google", googleAuthLimiter, googleAuthLogin);

/**
 * @route   POST /api/auth/admin/signup
 * @desc    Protected Admin Creation
 * @access  Private
 */
router.post("/admin/signup", authLimiter, validate(adminSignupSchema), adminSignup);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh Token
 * @access  Public
 */
router.post("/refresh", authLimiter, refreshToken);

/**
 * @route   POST /api/auth/admin/verify
 * @desc    Verify Admin with code
 * @access  Public
 */
router.post("/admin/verify", authLimiter, validate(adminVerifySchema), adminVerify);

/**
 * @route   POST /api/auth/admin/google-phase-one
 * @desc    Admin Google Auth Phase 1
 * @access  Public
 */
router.post("/admin/google-phase-one", googleAuthLimiter, adminGooglePhaseOne);

/**
 * @route   POST /api/auth/admin/verify-master-password
 * @desc    Admin Master Password Phase 2
 * @access  Public
 */
router.post("/admin/verify-master-password", authLimiter, adminMasterPasswordPhaseTwo);

module.exports = router;
