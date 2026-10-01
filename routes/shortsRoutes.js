const express = require('express');
const router = express.Router();
const {
  getShorts,
  toggleLikeShort,
  addShortComment,
  getShortComments,
  getShortsByChannel, // Import new method
} = require('../controllers/shortsController');
const { isAuthenticated, isActiveUser } = require('../middleware/authMiddleware');

// Public / User routes
router.get('/', getShorts);
router.get('/feed', getShorts);
router.get('/channel/:channelId', getShortsByChannel); // New route for shorts by channel
router.post('/:id/like', isAuthenticated, isActiveUser, toggleLikeShort);
router.post('/:id/comments', isAuthenticated, isActiveUser, addShortComment);
router.get('/:id/comments', getShortComments);

module.exports = router;
