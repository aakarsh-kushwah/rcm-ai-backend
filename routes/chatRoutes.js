const express = require('express');
const { handleChat, handleSpeak, getAllChats } = require('../controllers/chatController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

const router = express.Router();

// AI Chat (Text)
router.post('/', isAuthenticated, handleChat);

// ✅ AI Voice (Audio)
router.post('/speak', isAuthenticated, handleSpeak);

// Admin
router.get('/all', isAuthenticated, isAdmin, getAllChats); 

module.exports = router;