const express = require('express');
const { handleChat, handleSpeak, getAllChats } = require('../controllers/chatController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

const router = express.Router();

// 1. AI चैट के लिए (Text Response)
router.post('/', isAuthenticated, handleChat);

// 2. ✅ NEW: AI वॉइस के लिए (Audio Response)
router.post('/speak', isAuthenticated, handleSpeak);

// 3. एडमिन के लिए (All Chats)
router.get('/all', isAuthenticated, isAdmin, getAllChats); 

module.exports = router;