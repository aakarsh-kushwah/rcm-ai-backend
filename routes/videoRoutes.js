const express = require('express');
const router = express.Router();

// Middleware (यह 'isAuthenticated' और 'isAdmin' को इम्पोर्ट करता है)
// हम 'isAuthenticated' का इस्तेमाल करते हैं, जो डेटाबेस को हिट नहीं करता है
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); 

// कंट्रोलर से सभी फ़ंक्शंस को इम्पोर्ट करें
const { 
    saveVideoMetadata, 
    getLeaderVideos, 
    updateLeaderVideo, 
    deleteLeaderVideo,
    getProductVideos,
    updateProductVideo,
    deleteProductVideo
} = require('../controllers/videoController'); 

// ============================================================
// 🔹 1. Public Routes (जो यूज़र लॉग इन हैं)
// ============================================================

// GET /api/videos/leaders (यूज़र के लिए - पेजिनेशन के साथ)
router.get('/leaders', isAuthenticated, getLeaderVideos); 

// GET /api/videos/products (यूज़र के लिए - पेजिनेशन के साथ)
router.get('/products', isAuthenticated, getProductVideos);


// ============================================================
// 🔹 2. Admin Routes (सिर्फ़ एडमिन के लिए)
// ============================================================

// हम 'isAuthenticated' और 'isAdmin' दोनों का इस्तेमाल करते हैं
router.use(isAuthenticated, isAdmin);

// POST /api/videos/save-link (एक नया वीडियो सेव करें)
router.post('/save-link', saveVideoMetadata); 

// --- लीडर वीडियो के लिए एडमिन रूट्स ---

// PUT /api/videos/leaders/:id (लीडर वीडियो अपडेट करें)
router.put('/leaders/:id', updateLeaderVideo);

// DELETE /api/videos/leaders/:id (लीडर वीडियो डिलीट करें)
router.delete('/leaders/:id', deleteLeaderVideo);

// --- प्रोडक्ट वीडियो के लिए एडमिन रूट्स ---

// PUT /api/videos/products/:id (प्रोडक्ट वीडियो अपडेट करें)
router.put('/products/:id', updateProductVideo);

// DELETE /api/videos/products/:id (प्रोडक्ट वीडियो डिलीट करें)
router.delete('/products/:id', deleteProductVideo);

module.exports = router;

