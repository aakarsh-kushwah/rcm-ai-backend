const express = require('express');
const router = express.Router();

// Middleware assumed to be available: protect (for authentication), isAdmin (for authorization)
const { protect, isAdmin } = require('../middleware/authMiddleware'); 

// Import handlers from videoController.js
const { 
    saveVideoMetadata, 
    getLeaderVideos, 
    updateLeaderVideo, 
    deleteLeaderVideo,
    getProductVideos,
    updateProductVideo,
    deleteProductVideo
} = require('../controllers/videoController'); 

// --- Link Submission Route (Requires Admin) ---

// CRITICAL: Defines the endpoint for saving YouTube links metadata
// Admin submits the title, description, and YouTube URL.
// Path: POST /api/videos/save-link
router.post('/save-link', protect, isAdmin, saveVideoMetadata); 

// --- Video Data Handling Routes (Protected) ---

// Leader Video CRUD
// FIX: GET route requires only authentication (protect) for users to view videos
// Path: GET /api/videos/leaders
router.get('/leaders', protect, getLeaderVideos); 
// Path: PUT /api/videos/leaders/:id (Admin only)
router.put('/leaders/:id', protect, isAdmin, updateLeaderVideo);
// Path: DELETE /api/videos/leaders/:id (Admin only)
router.delete('/leaders/:id', protect, isAdmin, deleteLeaderVideo);

// Product Video CRUD
// Path: GET /api/videos/products
router.get('/products', protect, getProductVideos);
// Path: PUT /api/videos/products/:id (Admin only)
router.put('/products/:id', protect, isAdmin, updateProductVideo);
// Path: DELETE /api/videos/products/:id (Admin only)
router.delete('/products/:id', protect, isAdmin, deleteProductVideo);

module.exports = router;
