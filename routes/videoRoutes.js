const express = require('express');
const router = express.Router();

// ✅ Import all necessary middleware
const { isAuthenticated, isAdmin, isActiveUser } = require('../middleware/authMiddleware'); 

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
// 1. Public Routes (For Users)
// ============================================================
// ✅ UPDATE: Added 'isActiveUser' to these routes.
// Users must be logged in AND have 'active' status to see these.
router.get('/leaders', isAuthenticated, isActiveUser, getLeaderVideos); 
router.get('/products', isAuthenticated, isActiveUser, getProductVideos);
router.get('/products/categories', isAuthenticated, isActiveUser, getProductCategories);

// ============================================================
// 2. Admin Routes (For Admins Only)
// ============================================================
// Admin routes generally don't need 'isActiveUser' checks, just 'isAdmin'
router.use(isAuthenticated, isAdmin); 

// ✅ Existing Batch Import Route
router.post('/batch-scrape-import', batchScrapeImport); 

// --- Leader Video Admin ---
router.put('/leaders/:id', updateLeaderVideo);
router.delete('/leaders/:id', deleteLeaderVideo);

// --- Product Video Admin ---
router.put('/products/:id', updateProductVideo);
router.delete('/products/:id', deleteProductVideo);

module.exports = router;