const express = require('express');
const { handleChat, getAllChats } = require('../controllers/chatController');
const { protect, isAdmin } = require('../middleware/authMiddleware');
const router = express.Router();

// Protected route for logged-in users
router.post('/', protect, handleChat);

// Protected Admin route
router.get('/admin/chats', protect, isAdmin, getAllChats);

module.exports = router;
