const express = require('express');
const router = express.Router();
const {
  resolveChannel,
  createChannel,
  getChannels,
  getAdminChannels,
  getChannelById,
  getChannelVideos,
  toggleChannelActive,
  toggleLiveStatus,
  syncChannelOnDemand,
  syncChannelShortsNow,
  deleteChannel,
} = require('../controllers/channelController');
const { isAuthenticated, restrictTo } = require('../middleware/authMiddleware');

// Public routes
router.get('/', getChannels);
router.get('/:id', getChannelById);
router.get('/:id/videos', getChannelVideos);

// Admin protected routes
router.post('/resolve', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), resolveChannel);
router.post('/', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), createChannel);
router.get('/admin/all', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), getAdminChannels);
router.patch('/:id/toggle', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), toggleChannelActive);
router.patch('/:id/toggle-live', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), toggleLiveStatus);
router.post('/:id/sync', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), syncChannelOnDemand);
router.post('/:id/sync-shorts', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), syncChannelShortsNow);
router.delete('/:id', isAuthenticated, restrictTo('SUPER_ADMIN', 'ADMIN'), deleteChannel);

module.exports = router;
