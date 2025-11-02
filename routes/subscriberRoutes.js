const express = require('express');
const { addSubscriber, getAllSubscribers } = require('../controllers/subscriberController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); // ✅ 'protect' को 'isAuthenticated' से बदला गया
const router = express.Router();

// Public route
router.post('/subscribe', addSubscriber);

// Protected Admin route
router.get('/subscribers', isAuthenticated, isAdmin, getAllSubscribers);

module.exports = router;
