const express = require('express');
const router = express.Router();
const lifelinesController = require('../controllers/lifelinesController');
const { requireLifelinesAuth } = require('../services/lifelinesAuth');

// Public: the only route that receives the RCM password (rate-limited inside the controller)
router.post('/sync', lifelinesController.syncLifelines);

// Everything below needs the token returned by /sync
router.use(requireLifelinesAuth);

// 1. Static routes first
router.post('/logout', lifelinesController.logoutLifelines);
router.get('/assistant-query', lifelinesController.getAssistantQuery);
router.get('/turnover-history', lifelinesController.getTurnoverHistory);
router.get('/tree-children', lifelinesController.getTreeChildren);
router.post('/photo', lifelinesController.updateCustomPhoto);
router.get('/search', lifelinesController.searchLifelines);

// 2. Parameterized routes after
router.get('/status/:buyerId', lifelinesController.getSyncStatus);
router.get('/overview/:buyerId', lifelinesController.getLifelinesOverview);
router.get('/children/:buyerId', lifelinesController.getLifelinesChildren);
router.get('/territory/:buyerId', lifelinesController.getTerritorySummary);
router.get('/followup/:buyerId', lifelinesController.getFollowupList);
router.get('/member/:buyerId', lifelinesController.getMemberFullProfile);
router.get('/turnover/:buyerId', lifelinesController.getTurnoverHistory);

module.exports = router;