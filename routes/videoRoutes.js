// backend/routes/videoRoutes.js
const express = require('express');
const router = express.Router();

const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

const { 
    batchScrapeImport, // ✅ Naya import
    getLeaderVideos, 
    updateLeaderVideo, 
    deleteLeaderVideo,
    getProductVideos,
    updateProductVideo,
    deleteProductVideo
} = require('../controllers/videoController'); 

// ============================================================
// 1. Public Routes (यूज़र के लिए)
// ============================================================
router.get('/leaders', isAuthenticated, getLeaderVideos); 
router.get('/products', isAuthenticated, getProductVideos);

// ============================================================
// 2. Admin Routes (एडमिन के लिए)
// ============================================================
router.use(isAuthenticated, isAdmin);

// ✅ Naya Route: Multiple URLs ko scrape aur import karein
// POST /api/videos/batch-scrape-import
router.post('/batch-scrape-import', batchScrapeImport); 

// --- (पुराने '/save-link' और '/batch-import' को हटा दिया गया है) ---

// --- Leader Video Admin ---
router.put('/leaders/:id', updateLeaderVideo);
router.delete('/leaders/:id', deleteLeaderVideo);

// --- Product Video Admin ---
router.put('/products/:id', updateProductVideo);
router.delete('/products/:id', deleteProductVideo);

module.exports = router;