const express = require('express');
const router = express.Router();
const multer = require('multer');

// ============================================================
// 📦 MULTER CONFIG (Memory Storage – Audio Upload)
// ============================================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ============================================================
// 🎯 CONTROLLERS
// ============================================================
const {
    handleChat,
    handleSpeak,
    addSmartResponse,
    upgradeToPremium,

    // 🔥 ADMIN CHAT VIEW
    getAllChatUsers,
    getChatHistoryByUser
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
// 💬 USER CHAT ROUTES
// ============================================================

// 1️⃣ User → AI Chat (Text / Hybrid Audio)
router.post(
    '/',
    isAuthenticated,
    isActiveUser,
    handleChat
);

// 2️⃣ User → Direct TTS Request
router.post(
    '/speak',
    isAuthenticated,
    isActiveUser,
    handleSpeak
);

// ============================================================
// 🧑‍💼 ADMIN CHAT VIEW ROUTES (READ ONLY)
// ============================================================

// 3️⃣ Admin → Get All Users Who Chatted (Sidebar List)
router.get(
    '/all',
    isAuthenticated,
    isAdmin,
    getAllChatUsers
);

// 4️⃣ Admin → Get Chat History of a User
router.get(
    '/history/:userId',
    isAuthenticated,
    isAdmin,
    getChatHistoryByUser
);

// ============================================================
// 🛡️ ADMIN SMART RESPONSE MANAGEMENT
// ============================================================

// 5️⃣ Admin → Add New Smart Q&A (Optional Audio)
router.post(
    '/admin/smart-response',
    isAuthenticated,
    isAdmin,
    upload.single('audioFile'),
    addSmartResponse
);

// 6️⃣ Admin → Upgrade Existing Q&A to Premium
router.post(
    '/admin/upgrade',
    isAuthenticated,
    isAdmin,
    upload.single('audioFile'),
    upgradeToPremium
);

module.exports = router;
