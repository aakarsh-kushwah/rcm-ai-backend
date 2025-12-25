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
    deleteProductVideo,
    // ✅ Naya: Category list ke liye
    getProductCategories 
} = require('../controllers/videoController'); 

// ============================================================
// 1. Public Routes (यूज़र के लिए)
// ============================================================
router.get('/leaders', isAuthenticated, getLeaderVideos); 
router.get('/products', isAuthenticated, getProductVideos);
// ✅ NAYA: Product categories fetch karne ke liye
router.get('/products/categories', isAuthenticated, getProductCategories);

// ============================================================
// 2. Admin Routes (एडमिन के लिए)
// ============================================================
router.use(isAuthenticated, isAdmin); // Iske neeche sab routes admin-only hain

// ✅ Naya Route: Multiple URLs ko scrape aur import karein
// POST /api/videos/batch-scrape-import
router.post('/batch-scrape-import', batchScrapeImport); 

// --- Leader Video Admin ---
router.put('/leaders/:id', updateLeaderVideo);
router.delete('/leaders/:id', deleteLeaderVideo);

// --- Product Video Admin ---
router.put('/products/:id', updateProductVideo);
router.delete('/products/:id', deleteProductVideo);

module.exports = router;