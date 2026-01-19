/**
 * @file src/routes/chatRoutes.js
 * @description RCM Titan ASI Engine - Routing Layer
 * Handles Text, Voice, and Vision traffic efficiently.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');

// ============================================================
// 📦 MULTER CONFIG (Memory Storage)
// Used for Admin Audio Uploads (Smart Response)
// ============================================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit (Audio/Image)
});

// ============================================================
// 🎯 CONTROLLER IMPORTS
// We are importing from the UPDATED ASI Controller
// ============================================================
const {
    handleChat,            // The Main ASI Brain (Text/Image -> Logic -> Response)
    handleSpeak,           // Direct TTS (Text -> Audio)
    addSmartResponse,      // Admin: Add FAQ
    upgradeToPremium,      // Admin: Upgrade FAQ
    getAllChatUsers,       // Admin: User List
    getChatHistoryByUser   // Admin: Spy Mode (Monitoring)
} = require('../controllers/chatController');

// ============================================================
// 🛡️ MIDDLEWARE
// ============================================================
const {
    isAuthenticated,
    isAdmin,
    isActiveUser
} = require('../middleware/authMiddleware');

// ============================================================
// 💬 USER AI INTERACTION ROUTES (The ASI Interface)
// ============================================================

/**
 * @route   POST /api/chat/
 * @desc    Main Titan Interface. Handles:
 * 1. Text Queries (RAG + Groq)
 * 2. Image Analysis (Vision)
 * @access  Private (Active Users Only)
 * @body    { message: "string", image: "base64_string" (optional) }
 */
router.post(
    '/',
    isAuthenticated,
    isActiveUser,
    handleChat // <-- Yeh ASI Controller function ko call karega
);

/**
 * @route   POST /api/chat/speak
 * @desc    Direct Text-to-Speech (Edge TTS)
 * Used when user clicks "Play" on a message manually.
 * @access  Private
 */
router.post(
    '/speak',
    isAuthenticated,
    isActiveUser,
    handleSpeak
);

// ============================================================
// 🧑‍💼 ADMIN INTELLIGENCE & MONITORING
// (Control Room for Titan ASI)
// ============================================================

/**
 * @route   GET /api/chat/all
 * @desc    Fetch list of users interacting with AI
 * @access  Private (Admin)
 */
router.get(
    '/all',
    isAuthenticated,
    isAdmin,
    getAllChatUsers
);

/**
 * @route   GET /api/chat/history/:userId
 * @desc    View full conversation log (Debugging/Monitoring)
 * @access  Private (Admin)
 */
router.get(
    '/history/:userId',
    isAuthenticated,
    isAdmin,
    getChatHistoryByUser
);

/**
 * @route   POST /api/chat/admin/smart-response
 * @desc    Add specific answers manually (Overriding AI)
 * Useful for Fixed Company Info.
 * @access  Private (Admin)
 */
router.post(
    '/admin/smart-response',
    isAuthenticated,
    isAdmin,
    upload.single('audioFile'), // Admin can upload custom voice note
    addSmartResponse
);

/**
 * @route   POST /api/chat/admin/upgrade
 * @desc    Edit/Upgrade an existing AI response
 * @access  Private (Admin)
 */
router.post(
    '/admin/upgrade',
    isAuthenticated,
    isAdmin,
    upload.single('audioFile'),
    upgradeToPremium
);

module.exports = router;