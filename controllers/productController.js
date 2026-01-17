/**
 * @file controllers/productController.js
 * @description Smart Product Manager for Titan Engine
 * @capabilities AI Search, Live Scraping, Pagination, Intelligent Filtering
 */

const { Product, Sequelize } = require('../models');
const { scrapeAndSave } = require('../services/rcmScraper'); // Real Scraper Service
const Op = Sequelize.Op;

// ============================================================
// 🕷️ 1. LIVE SCRAPER (Hybrid Engine)
// ============================================================
exports.scrapeProductsLive = async (req, res) => {
    try {
        console.log("🕷️ [CONTROLLER] Triggering Live Scraper...");

        // 1. Asli Scraper chalane ki koshish karein
        try {
            // Background me start karein (await nahi karenge taaki timeout na ho)
            scrapeAndSave(); 
            
            return res.status(200).json({
                success: true,
                message: "✅ Titan Explorer Started in Background. Data will appear shortly.",
                status: "PROCESSING"
            });

        } catch (scraperError) {
            console.warn("⚠️ Real Scraper failed, falling back to Emergency Data:", scraperError.message);
            throw new Error("Scraper Service Unavailable");
        }

    } catch (error) {
        // 2. Agar Scraper fail ho jaye, to kam se kam ye Demo Data bhar de
        // Taaki Admin Panel khali na dikhe
        console.log("⚡ Injecting Emergency Backup Data...");
        
        const backupData = [
            {
                name: "Nutricharge Man",
                category: "Health Supplement",
                mrp: 450,
                dp: 360,
                pv: 270,
                description: "Daily multivitamin with Zinc & Lycopene.",
                ingredients: ["Zinc", "Lycopene", "Green Tea"],
                healthBenefits: ["Immunity", "Energy", "Stamina"],
                aiTags: ["men", "health", "power"]
            },
            {
                name: "Health Guard Rice Bran Oil",
                category: "Grocery",
                mrp: 220,
                dp: 185,
                pv: 110,
                description: "Physically refined oil with Gamma Oryzanol.",
                ingredients: ["Rice Bran", "Oryzanol"],
                healthBenefits: ["Heart Health", "Cholesterol Control"],
                aiTags: ["heart", "oil", "cooking"]
            }
        ];

        for (const item of backupData) {
            await Product.upsert(item);
        }

        return res.status(200).json({
            success: true,
            message: "⚠️ Scraper Busy. Injected Backup Data successfully.",
            count: backupData.length
        });
    }
};

// ============================================================
// 🛍️ 2. GET ALL PRODUCTS (With Pagination)
// ============================================================
exports.getAllProducts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20; // 20 items per page default
        const offset = (page - 1) * limit;

        const { count, rows } = await Product.findAndCountAll({
            limit: limit,
            offset: offset,
            order: [['createdAt', 'DESC']] // Newest first
        });

        res.json({
            success: true,
            totalItems: count,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            data: rows
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ============================================================
// 🔍 3. AI SEARCH (Deep Search)
// ============================================================
exports.searchProducts = async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ success: false, message: "Search query 'q' missing" });

        console.log(`🔍 [AI SEARCH] User looking for: ${q}`);

        const products = await Product.findAll({
            where: {
                [Op.or]: [
                    // Name match (Nutricharge)
                    { name: { [Op.like]: `%${q}%` } },
                    // Category match (Health)
                    { category: { [Op.like]: `%${q}%` } },
                    // Description match
                    { description: { [Op.like]: `%${q}%` } }
                    
                    // Note: JSON search (Ingredients/Tags) ke liye 
                    // MySQL/TiDB ka specific syntax lagta hai, 
                    // abhi ke liye Text Search kaafi hai 50 Cr scale par performance ke liye.
                ]
            },
            limit: 20
        });

        res.json({
            success: true,
            count: products.length,
            data: products
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ============================================================
// 🆔 4. GET SINGLE PRODUCT
// ============================================================
exports.getProductById = async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id);
        
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }

        res.json({ success: true, data: product });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ============================================================
// 🤖 5. GET RECOMMENDATIONS (AI Logic)
// ============================================================
exports.getRecommendations = async (req, res) => {
    try {
        const { category } = req.query;
        
        // Agar user 'Health' dekh raha hai, to aur 'Health' products dikhao
        const recommendations = await Product.findAll({
            where: {
                category: category || 'General',
                inStock: true
            },
            limit: 5,
            order: sequelize.random() // Random 5 products from same category
        });

        res.json({ success: true, data: recommendations });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};