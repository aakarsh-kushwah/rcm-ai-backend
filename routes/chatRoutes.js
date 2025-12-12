const express = require('express');
const router = express.Router();
const multer = require('multer'); // Import Multer

// Setup Multer (RAM Storage)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const { 
    handleChat, 
    handleSpeak, 
    getAllChats, 
    addSmartResponse 
} = require('../controllers/chatController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

// 1. Text Chat
router.post('/', isAuthenticated, handleChat);

// 2. Voice Chat
router.post('/speak', isAuthenticated, handleSpeak);

// 3. Admin: Smart Response with File Upload
// ⚠️ Note: 'audioFile' is the field name we will use in Frontend
router.post('/admin/smart-response', isAuthenticated, isAdmin, upload.single('audioFile'), addSmartResponse);

// 4. Get Chats
router.get('/all', isAuthenticated, isAdmin, getAllChats); 

module.exports = router;