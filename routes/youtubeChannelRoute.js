const express = require('express');
const router = express.Router();

const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

const { 
    batchScrapeImport, 
    getLeaderVideos, 
    updateLeaderVideo, 
    deleteLeaderVideo,
    getProductVideos,
    updateProductVideo,
    deleteProductVideo,
    getProductCategories,
    // ✅ NAYE YOUTUBE CONTROLLER FUNCTIONS
    addChannelOrVideo,
    getAllChannels,
    deleteChannel,
    deleteVideoFromChannel,
} = require('../controllers/videoController'); 

// ============================================================
// 1. Public Routes (यूज़र के लिए)
// ============================================================
router.get('/leaders', isAuthenticated, getLeaderVideos); 
router.get('/products', isAuthenticated, getProductVideos);
router.get('/products/categories', isAuthenticated, getProductCategories);

// ✅ NAYA ROUTE: Get all YouTube channels and their videos (UI Listing)
// GET /api/videos/youtube-channels
router.get('/youtube-channels', isAuthenticated, getAllChannels);


// ============================================================
// 2. Admin Routes (एडमिन के लिए)
// ============================================================
router.use(isAuthenticated, isAdmin); // Iske neeche sab routes admin-only hain

// POST /api/videos/batch-scrape-import (Leaders & Products bulk import)
router.post('/batch-scrape-import', batchScrapeImport); 

// --- YouTube Channel Admin ---
// POST /api/videos/youtube-channels (नया चैनल या वीडियो जोड़ना)
router.post('/youtube-channels', addChannelOrVideo); 

// DELETE /api/videos/youtube-channels/:channelId (पूरा चैनल डिलीट)
router.delete('/youtube-channels/:channelId', deleteChannel);

// DELETE /api/videos/youtube-channels/:channelId/videos/:videoId (चैनल से एक वीडियो डिलीट)
router.delete('/youtube-channels/:channelId/videos/:videoId', deleteVideoFromChannel);


// --- Leader Video Admin ---
router.put('/leaders/:id', updateLeaderVideo);
router.delete('/leaders/:id', deleteLeaderVideo);

// --- Product Video Admin ---
router.put('/products/:id', updateProductVideo);
router.delete('/products/:id', deleteProductVideo);

module.exports = router;