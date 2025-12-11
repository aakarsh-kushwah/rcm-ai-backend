const express = require('express');
const { 
    handleChat, 
    handleSpeak, 
    getAllChats, 
    addSmartResponse // ✅ Using the Smart Response function
} = require('../controllers/chatController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

const router = express.Router();

// 1. Text Chat (Checks FAQ first, then AI)
router.post('/', isAuthenticated, handleChat);

// 2. Voice Chat (Checks Voice Cache first, then ElevenLabs)
router.post('/speak', isAuthenticated, handleSpeak);

// 3. Admin: Add Smart FAQ (Saves to both DBs for Zero Cost)
router.post('/admin/smart-response', isAuthenticated, isAdmin, addSmartResponse);

// 4. Admin: View Chats
router.get('/all', isAuthenticated, isAdmin, getAllChats); 

module.exports = router;