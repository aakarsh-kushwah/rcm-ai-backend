const express = require('express');
const router = express.Router();

const { isAuthenticated, isAdmin, restrictTo } = require('../middleware/authMiddleware'); 

const { 
    batchScrapeImport, 
    getLeaderVideos, 
    updateLeaderVideo, 
    deleteLeaderVideo,
    getProductVideos,
    updateProductVideo,
    deleteProductVideo,
    getProductCategories 
} = require('../controllers/videoController'); 

// ============================================================
// 1. Public / Authenticated Free Routes (For Users)
// ============================================================
router.get('/leaders', isAuthenticated, getLeaderVideos); 
router.get('/products', isAuthenticated, getProductVideos);
router.get('/products/categories', isAuthenticated, getProductCategories);

// ============================================================
// 2. Admin Routes (For Admins Only)
// ============================================================
router.use(isAuthenticated, isAdmin); 

router.post('/batch-scrape-import', restrictTo('SUPER_ADMIN', 'ADMIN'), batchScrapeImport); 

// --- Leader Video Admin ---
router.put('/leaders/:id', restrictTo('SUPER_ADMIN', 'ADMIN'), updateLeaderVideo);
router.delete('/leaders/:id', restrictTo('SUPER_ADMIN', 'ADMIN'), deleteLeaderVideo);

// --- Product Video Admin ---
router.put('/products/:id', restrictTo('SUPER_ADMIN', 'ADMIN'), updateProductVideo);
router.delete('/products/:id', restrictTo('SUPER_ADMIN', 'ADMIN'), deleteProductVideo);

module.exports = router;