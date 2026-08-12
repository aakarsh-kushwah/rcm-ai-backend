/**
 * @file controllers/productController.js
 * @description Smart Product Manager for Titan Engine
 * @capabilities AI Search, Live Scraping, Pagination, Intelligent Filtering, Product Management
 */

const { Product, Sequelize } = require("../models");
const { scrapeAndSave } = require("../services/rcmScraper"); // Real Scraper Service
const { uploadProductImage } = require("../services/cloudinaryService"); // Cloudinary Service
const Op = Sequelize.Op;
const { logger } = require("../utils/logger"); // Import logger from common utility

// ============================================================
// 🕷️ 1. LIVE SCRAPER (Hybrid Engine)
// ============================================================
exports.scrapeProductsLive = async (req, res) => {
    try {
        logger.info({ traceId: req.id }, "Triggering Live Scraper...");
        // Background me start karein (await nahi karenge taaki timeout na ho)
        scrapeAndSave(); 
        
        return res.status(200).json({
            success: true,
            message: "✅ Titan Explorer Started in Background. Data will appear shortly.",
            status: "PROCESSING"
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Scraper Trigger Error");
        return res.status(500).json({ success: false, message: "Failed to trigger scraper." });
    }
};

// ============================================================
// 🆕 2. CREATE PRODUCT (Admin)
// ============================================================
exports.createProduct = async (req, res) => {
    try {
        const { name, category, mrp, dp, pv, description, ingredients, healthBenefits, usageInfo, sitePath, productUrl, aiTags, isFeatured } = req.body;
        let imageUrl = null;

        // Handle image upload if present
        if (req.file && req.file.buffer) {
            const cdnUrl = await uploadProductImage(req.file.buffer, name);
            if (cdnUrl) imageUrl = cdnUrl;
        }

        const newProduct = await Product.create({
            name,
            category,
            mrp,
            dp,
            pv,
            description,
            ingredients: ingredients ? JSON.parse(ingredients) : [],
            healthBenefits: healthBenefits ? JSON.parse(healthBenefits) : [],
            usageInfo: usageInfo ? JSON.parse(usageInfo) : {},
            sitePath,
            productUrl,
            imageUrl,
            aiTags: aiTags ? JSON.parse(aiTags) : [],
            isFeatured
        });

        logger.info({ traceId: req.id, productId: newProduct.id, productName: newProduct.name }, "Product created successfully");
        return res.status(201).json({ success: true, message: "Product created successfully.", data: newProduct });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Create Product Error");
        return res.status(500).json({ success: false, message: "Failed to create product.", error: error.message });
    }
};

// ============================================================
// 🔄 3. UPDATE PRODUCT (Admin)
// ============================================================
exports.updateProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, category, mrp, dp, pv, description, ingredients, healthBenefits, usageInfo, sitePath, productUrl, aiTags, isFeatured } = req.body;
        
        const product = await Product.findByPk(id);
        if (!product) {
            logger.warn({ traceId: req.id, productId: id }, "Product not found for update");
            return res.status(404).json({ success: false, message: "Product not found." });
        }

        let imageUrl = product.imageUrl;

        // Handle image upload if present
        if (req.file && req.file.buffer) {
            const cdnUrl = await uploadProductImage(req.file.buffer, name);
            if (cdnUrl) imageUrl = cdnUrl;
        }

        const updatedFields = {
            name,
            category,
            mrp,
            dp,
            pv,
            description,
            ingredients: ingredients ? JSON.parse(ingredients) : product.ingredients,
            healthBenefits: healthBenefits ? JSON.parse(healthBenefits) : product.healthBenefits,
            usageInfo: usageInfo ? JSON.parse(usageInfo) : product.usageInfo,
            sitePath,
            productUrl,
            imageUrl,
            aiTags: aiTags ? JSON.parse(aiTags) : product.aiTags,
            isFeatured
        };

        await product.update(updatedFields);

        logger.info({ traceId: req.id, productId: product.id, productName: product.name }, "Product updated successfully");
        return res.status(200).json({ success: true, message: "Product updated successfully.", data: product });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Update Product Error");
        return res.status(500).json({ success: false, message: "Failed to update product.", error: error.message });
    }
};

// ============================================================
// 🛍️ 4. GET ALL PRODUCTS (With Pagination)
// ============================================================
exports.getAllProducts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20; // 20 items per page default
        const offset = (page - 1) * limit;

        const { count, rows } = await Product.findAndCountAll({
            limit: limit,
            offset: offset,
            order: [["createdAt", "DESC"]] // Newest first
        });

        logger.info({ traceId: req.id, page, limit, totalItems: count }, "Fetched all products");
        res.json({
            success: true,
            totalItems: count,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            data: rows
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Fetch All Products Error");
        res.status(500).json({ success: false, error: error.message });
    }
};

// ============================================================
// 🔍 5. AI SEARCH (Deep Search)
// ============================================================
exports.searchProducts = async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            logger.warn({ traceId: req.id }, "Search query 'q' missing");
            return res.status(400).json({ success: false, message: "Search query 'q' missing" });
        }

        logger.info({ traceId: req.id, query: q }, "User looking for products");

        const products = await Product.findAll({
            where: {
                [Op.or]: [
                    { name: { [Op.like]: `%${q}%` } },
                    { category: { [Op.like]: `%${q}%` } },
                    { description: { [Op.like]: `%${q}%` } }
                ]
            },
            limit: 20
        });

        logger.info({ traceId: req.id, query: q, count: products.length }, "Products search complete");
        res.json({
            success: true,
            count: products.length,
            data: products
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Search Products Error");
        res.status(500).json({ success: false, error: error.message });
    }
};

// ============================================================
// 🆔 6. GET SINGLE PRODUCT
// ============================================================
exports.getProductById = async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id);
        
        if (!product) {
            logger.warn({ traceId: req.id, productId: req.params.id }, "Product not found by ID");
            return res.status(404).json({ success: false, message: "Product not found" });
        }

        logger.info({ traceId: req.id, productId: product.id }, "Fetched single product by ID");
        res.json({ success: true, data: product });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Get Product By ID Error");
        res.status(500).json({ success: false, error: error.message });
    }
};

// ============================================================
// 🤖 7. GET RECOMMENDATIONS (AI Logic)
// ============================================================
exports.getRecommendations = async (req, res) => {
    try {
        const { category } = req.query;
        
        logger.info({ traceId: req.id, category }, "Fetching product recommendations");
        const recommendations = await Product.findAll({
            where: {
                category: category || "General",
                isAvailable: true
            },
            limit: 5,
            order: Sequelize.literal("rand()") // Random 5 products from same category
        });

        logger.info({ traceId: req.id, category, count: recommendations.length }, "Product recommendations fetched");
        res.json({ success: true, data: recommendations });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Get Recommendations Error");
        res.status(500).json({ success: false, error: error.message });
    }
};

module.exports = exports;