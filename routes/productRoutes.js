/**
 * @file routes/productRoutes.js
 * @description API Routes for RCM Products & Scraper Trigger
 */

const express = require("express");
const router = express.Router();

// Controller Import
const productController = require("../controllers/productController");

// Middleware Imports
const { isAuthenticated, isActiveUser, isAdmin } = require("../middleware/authMiddleware");
const validate = require("../middleware/validate");
const upload = require("../middleware/uploadMiddleware");

// Schema Imports
const { productSchema, userIdParamSchema } = require("../validations/adminSchema"); // userIdParamSchema for :id validation

// ============================================================
// 🛡️ AUTHENTICATION & AUTHORIZATION (All routes below are protected)
// ============================================================
router.use(isAuthenticated, isActiveUser, isAdmin);

// ============================================================
// 🕷️ 1. SCRAPER ROUTE (Admin Only)
// ============================================================
// URL: GET /api/products/scrape-live
router.get("/scrape-live", productController.scrapeProductsLive);

// ============================================================
// 🆕 2. CREATE PRODUCT (Admin)
// ============================================================
// URL: POST /api/products
// CRITICAL: validate(productSchema) AFTER upload.single("productImage")
router.post("/", upload.single("productImage"), validate(productSchema), productController.createProduct);

// ============================================================
// 🔄 3. UPDATE PRODUCT (Admin)
// ============================================================
// URL: PATCH /api/products/:id
// CRITICAL: validate(productSchema) AFTER upload.single("productImage")
router.patch("/", upload.single("productImage"), validate(productSchema), productController.updateProduct);

// ============================================================
// 🛍️ 4. STANDARD PRODUCT ROUTES (Admin access for management)
// ============================================================
// URL: GET /api/products (Sare products)
router.get("/", productController.getAllProducts);

// URL: GET /api/products/search?q=nutricharge
router.get("/search", productController.searchProducts);

// URL: GET /api/products/:id (Specific ID)
router.get("/:id", validate(userIdParamSchema), productController.getProductById);

module.exports = router;