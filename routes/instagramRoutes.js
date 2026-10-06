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
  res.status(200).json({ success: true, message: 'Instagram admin service is active.' });
});

// Import
router.post('/import', ...admin, instagramController.importReelOrAccount);
router.post('/import-bulk', ...admin, instagramController.bulkImport);

// Accounts
router.get('/accounts', ...admin, instagramController.getAccounts);
router.post('/accounts/:id/sync', ...admin, instagramController.syncAccount);
router.patch('/accounts/:id/toggle', ...admin, instagramController.toggleAccount);
router.delete('/accounts/:id', ...admin, instagramController.deleteAccount);

// Reels
router.get('/reels', ...admin, instagramController.getReels);
router.patch('/reels/:id', ...admin, instagramController.updateReel);
router.patch('/reels/:id/toggle', ...admin, instagramController.toggleReel);
router.delete('/reels/:id', ...admin, instagramController.deleteReel);

module.exports = router;