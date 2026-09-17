const express = require('express');
const router = express.Router();
const {
  resolveChannel,
  createChannel,
  getChannels,
  getAdminChannels,
  getChannelVideos,
  toggleChannelActive,
  toggleLiveStatus,
  syncChannelOnDemand,
  deleteChannel,
} = require('../controllers/channelController');
const { isAuthenticated, isActiveUser, restrictTo } = require('../middleware/authMiddleware');

// Public routes
router.get('/', getChannels);
router.get('/:id/videos', getChannelVideos);

// Admin protected routes
router.post('/resolve', isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'), resolveChannel);
router.post('/', isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'), createChannel);
router.get('/admin/all', isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'), getAdminChannels);
router.patch('/:id/toggle', isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'), toggleChannelActive);
router.patch('/:id/toggle-live', isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'), toggleLiveStatus);
router.post('/:id/sync', isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'), syncChannelOnDemand);
router.delete('/:id', isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'), deleteChannel);

module.exports = router;
