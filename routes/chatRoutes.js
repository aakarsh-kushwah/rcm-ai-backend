const express = require('express');
const router = express.Router();

// Middleware assumed to be available
const { handleChat, getAllChats } = require('../controllers/chatController');
const { protect, isAdmin } = require('../middleware/authMiddleware'); // protect and isAdmin

// --- 1. User Chat Route ---
// Path: POST /api/chat (Requires authentication for all logged-in users)
router.post('/', protect, handleChat);

// --- 2. Admin History Route ---
// Path: GET /api/chat/admin/chats (Requires authentication AND Admin role)
router.get('/admin/chats', protect, isAdmin, getAllChats);

module.exports = router;