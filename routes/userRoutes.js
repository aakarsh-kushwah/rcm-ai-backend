// routes/chatRoutes.js
const express = require('express');
const router = express.Router();

const { handleChat, getAllChats } = require('../controllers/chatController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');

// POST /api/chat
router.post('/', isAuthenticated, handleChat);


module.exports = router;