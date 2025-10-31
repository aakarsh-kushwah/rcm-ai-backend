// backend/routes/chatRoutes.js
const express = require('express');
const router = express.Router();

const { handleChat, getAllChats } = require('../controllers/chatController');
const { protect, isAdmin } = require('../middleware/authMiddleware');


router.post('/', protect, handleChat);

router.get('/admin/chats', protect, isAdmin, getAllChats);

module.exports = router;
