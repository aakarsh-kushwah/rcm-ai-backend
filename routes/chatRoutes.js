const express = require('express');
const { handleChat, handleSpeak, getAllChats } = require('../controllers/chatController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

const router = express.Router();

// 1. Text Chat
router.post('/', isAuthenticated, handleChat);

// 2. ✅ Voice Chat (Yeh line ZARURI hai)
router.post('/speak', isAuthenticated, handleSpeak);

// 3. Admin Routes
router.get('/all', isAuthenticated, isAdmin, getAllChats); 

module.exports = router;