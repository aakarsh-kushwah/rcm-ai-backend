/**
 * @file instagramRoutes.js
 * @description Instagram admin routes.
 */

const express = require('express');
const router = express.Router();
const instagramController = require('../controllers/instagramController');
const { isAuthenticated, isActiveUser, restrictTo } = require('../middleware/authMiddleware');
const { getSyncActivity, isScraperEnabled } = require('../services/instagramSyncService');

const admin = [isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN')];

function requireScraperEnabled(req, res, next) {
  if (!isScraperEnabled()) {
    return res.status(503).json({
      success: false,
      code: 'SCRAPER_DISABLED',
      message: 'Scraping is disabled on this server. Requests must go to the tablet scraper.',
    });
  }
  return next();
}

router.get('/status', ...admin, (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Instagram admin service is active.',
    scraperEnabled: isScraperEnabled(),
  });
});

// Live sync activity & queue status (persists across page navigation/back)
router.get('/sync/activity', ...admin, (req, res) => {
  try {
    const activity = getSyncActivity();
    return res.status(200).json({
      success: true,
      data: activity,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load sync activity.',
    });
  }
});

// Import (offloaded to scraper worker)
router.post('/import', ...admin, requireScraperEnabled, instagramController.importReelOrAccount);
router.post('/import-bulk', ...admin, requireScraperEnabled, instagramController.bulkImport);

// Accounts
router.get('/accounts', ...admin, instagramController.getAccounts);
router.post(
  '/accounts/:id/sync',
  ...admin,
  requireScraperEnabled,
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