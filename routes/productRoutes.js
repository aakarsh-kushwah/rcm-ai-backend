/**
 * @file routes/productRoutes.js
 * @description API Routes for RCM Products & Scraper Trigger
 */

const express = require('express');
const router = express.Router();

// Controller Import (Path check karein: ../controllers)
const productController = require('../controllers/productController');

// ============================================================
// 🕷️ SCRAPER ROUTE (Ye sabse upar hona chahiye)
// ============================================================
// URL: http://localhost:10000/api/products/scrape-live
router.get('/scrape-live', productController.scrapeProductsLive);


// ============================================================
// 🛍️ STANDARD PRODUCT ROUTES
// ============================================================
// URL: http://localhost:10000/api/products (Sare products)
router.get('/', productController.getAllProducts);

// URL: http://localhost:10000/api/products/search?q=nutricharge
router.get('/search', productController.searchProducts);

// URL: http://localhost:10000/api/products/123 (Specific ID)
router.get('/:id', productController.getProductById);

module.exports = router;