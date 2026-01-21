const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { register, login, adminSignup } = require('../controllers/authController');

// 🛡️ SECURITY: Rate Limiter (Brute Force Protection)
// Login aur Signup par limits lagana zaroori hai taaki koi hacker server crash na kare
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minutes
    max: 20, // Har IP se sirf 20 requests allow hain 15 min mein
    message: { success: false, message: "Too many attempts. Please try again after 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * @route   POST /api/auth/register
 * @desc    User Registration
 * @access  Public
 */
router.post('/register', authLimiter, register);

/**
 * @route   POST /api/auth/login
 * @desc    User Login & Token Generation
 * @access  Public
 */
router.post('/login', authLimiter, login);

/**
 * @route   POST /api/auth/admin/signup
 * @desc    Protected Admin Creation
 * @access  Private (Ideally should be protected by a Master Key)
 */
// 💡 PRO TIP: Production mein admin signup ko band rakhein ya ek Secret Key se protect karein
router.post('/admin/signup', authLimiter, adminSignup);

module.exports = router;