const express = require('express');
const router = express.Router();
const multer = require('multer'); 

// ✅ Configure Multer (Memory Storage)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit
});

// ✅ Import Controller
const { 
    handleChat, 
    handleSpeak, 
    addSmartResponse,
    upgradeToPremium 
} = require('../controllers/chatController');

// ✅ Middleware
const { isAuthenticated, isAdmin, isActiveUser } = require('../middleware/authMiddleware'); 

// ============================================================
// 💬 USER ROUTES
// ============================================================

// 1. User Chat (Text + Hybrid Audio)
router.post('/', isAuthenticated, isActiveUser, handleChat);

// 2. Direct TTS (Explicit Request)
router.post('/speak', isAuthenticated, isActiveUser, handleSpeak);

// ============================================================
// 🛡️ ADMIN ROUTES (Only Admin can Insert Data)
// ============================================================

// 3. Admin: Add NEW Q&A Manually
router.post(
    '/admin/smart-response', 
    isAuthenticated, 
    isAdmin, 
    upload.single('audioFile'), 
    addSmartResponse
);

// 4. Admin: Upgrade Existing Q&A
router.post(
    '/admin/upgrade', 
    isAuthenticated, 
    isAdmin, 
    upload.single('audioFile'), 
    upgradeToPremium
);

module.exports = router;