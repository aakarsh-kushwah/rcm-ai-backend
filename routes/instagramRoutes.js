/**
 * @file instagramRoutes.js
 * @description Instagram admin routes.
 */

const express = require('express');
const router = express.Router();
const instagramController = require('../controllers/instagramController');
const { isAuthenticated, isActiveUser, restrictTo } = require('../middleware/authMiddleware');

const admin = [isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN')];

router.get('/status', ...admin, (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Instagram account management is active; scraping runs in the local worker.',
    scraperEnabled: false,
    worker: 'local',
  });
});

// Live sync activity & queue status (persists across page navigation/back)
router.get('/sync/activity', ...admin, (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      scraperEnabled: false,
      worker: 'local',
      status: 'idle',
      queuedCount: 0,
      queuedItems: [],
      activeAccountId: null,
      activeUsername: null,
      currentProgress: { scroll: 0, maxScrolls: 0, scrapedCount: 0, mode: null },
      lastJob: null,
      recentLogs: [],
    },
  });
});

// Account registration stays in the API; the standalone worker performs scraping.
router.post('/import', ...admin, instagramController.importReelOrAccount);
router.post('/import-bulk', ...admin, instagramController.bulkImport);

// Accounts
router.get('/accounts', ...admin, instagramController.getAccounts);
router.post(
  '/accounts/:id/sync',
  ...admin,
  instagramController.syncAccount
);
router.patch('/accounts/:id/toggle', ...admin, instagramController.toggleAccount);
router.delete('/accounts/:id', ...admin, instagramController.deleteAccount);

// Reels
router.get('/reels', ...admin, instagramController.getReels);
router.patch('/reels/:id', ...admin, instagramController.updateReel);
router.patch('/reels/:id/toggle', ...admin, instagramController.toggleReel);
router.delete('/reels/:id', ...admin, instagramController.deleteReel);

module.exports = router;