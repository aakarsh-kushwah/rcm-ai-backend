const express = require('express');
const router = express.Router();
const { handleChat } = require('../controllers/chatController');

// ✅ Import all 3 middlewares
const { isAuthenticated, isAdmin, isActiveUser } = require('../middleware/authMiddleware');

// User Chat (Login + Active Subscription Required)
router.post('/', isAuthenticated, isActiveUser, handleChat);

module.exports = router;