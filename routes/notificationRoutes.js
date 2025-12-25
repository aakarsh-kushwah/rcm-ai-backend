const express = require('express');
const router = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');
const { saveFcmToken, sendAnnouncement } = require('../controllers/notificationController');

// POST /api/notifications/save-token (Any logged-in user)
router.post('/save-token', isAuthenticated, saveFcmToken);

// POST /api/notifications/send (Admin only)
router.post('/send', isAuthenticated, isAdmin, sendAnnouncement);

module.exports = router;