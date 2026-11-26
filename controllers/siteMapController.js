/**
 * @file controllers/siteMapController.js
 * @description RCM Website Navigation Brain (The GPS)
 * @capabilities Live Mapping, AI Guide Generation, Neural Search
 */

const { SiteMap, Sequelize } = require('../models');
const Op = Sequelize.Op;

// ============================================================
// 🗺️ 1. LIVE SITEMAP GENERATOR (Hybrid Engine)
// ============================================================
exports.generateSiteMapLive = async (req, res) => {
    return res.status(503).json({
        success: false,
        code: "LOCAL_WORKER_REQUIRED",
        status: "OFFLOADED",
        message: "RCM portal scraping runs in the local portal worker.",
    });
};

// ============================================================
// 🔍 2. AI SEARCH (Find Links by Intent)
// ============================================================
exports.searchSiteMap = async (req, res) => {
    try {
        const { q } = req.query; // e.g. "paisa kahan dikhega"
        if (!q) return res.status(400).json({ error: "Query required" });

        console.log(`🧠 [AI NAV] Searching for: ${q}`);

        // Advanced Search: Title, Keywords, Section sabme dhundega
        const results = await SiteMap.findAll({
            where: {
                [Op.or]: [
                    { title: { [Op.like]: `%${q}%` } },
                    { section: { [Op.like]: `%${q}%` } },
                    // JSON search workaround for portability
                    // (Real production me hum JSON_CONTAINS use karte hain, par ye safer hai)
                    Sequelize.literal(`JSON_SEARCH(keywords, 'one', '%${q}%') IS NOT NULL`) 
                ]
            },
            limit: 5
        });

        // Agar DB me kuch na mile, to fallback (Fuzzy Logic)
        if (results.length === 0) {
            // AI logic: "income" = "statement"
            if (q.includes('income') || q.includes('paisa')) {
                 const fallback = await SiteMap.findOne({ where: { title: { [Op.like]: '%Statement%' } } });
                 return res.json({ success: true, ai_inference: true, data: fallback ? [fallback] : [] });
            }
        }

        res.json({ success: true, count: results.length, data: results });

    } catch (error) {
        // JSON search error handling (Agar purana MySQL ho)
        console.error("Search Error:", error.message);
        
        // Simple fallback search
        const simpleResults = await SiteMap.findAll({
            where: { title: { [Op.like]: `%${req.query.q}%` } }
        });
        res.json({ success: true, fallback_mode: true, data: simpleResults });
    }
};

// ============================================================
// 📂 3. GET ALL LINKS (For App Menu)
// ============================================================
exports.getAllLinks = async (req, res) => {
    try {
        const links = await SiteMap.findAll({
            attributes: ['title', 'link', 'section'], // Sirf zaruri data bhejo (Fast)
            order: [['section', 'ASC'], ['title', 'ASC']]
        });
        
        // Group by Section (Frontend ke liye aasan)
        const grouped = links.reduce((acc, item) => {
            if (!acc[item.section]) acc[item.section] = [];
            acc[item.section].push(item);
            return acc;
        }, {});

        res.json({ success: true, data: grouped });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};