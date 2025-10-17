const express = require('express');
const { addSubscriber, getAllSubscribers } = require('../controllers/subscriberController');
const { protect, isAdmin } = require('../middleware/authMiddleware');
const router = express.Router();

// Public route
router.post('/subscribe', addSubscriber);

// Protected Admin route
router.get('/subscribers', protect, isAdmin, getAllSubscribers);

module.exports = router;