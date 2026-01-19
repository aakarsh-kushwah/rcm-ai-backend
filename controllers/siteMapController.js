/**
 * @file controllers/siteMapController.js
 * @description RCM Website Navigation Brain (The GPS)
 * @capabilities Live Mapping, AI Guide Generation, Neural Search
 */

const { SiteMap, Sequelize } = require('../models');
const { scrapeAndSave } = require('../services/rcmScraper'); // Real Scraper
const Op = Sequelize.Op;

// ============================================================
// 🗺️ 1. LIVE SITEMAP GENERATOR (Hybrid Engine)
// ============================================================
exports.generateSiteMapLive = async (req, res) => {
    try {
        console.log("🗺️ [CONTROLLER] Triggering Knowledge Graph Update...");

        // 1. Koshish karein Real Scraper chalane ki
        try {
            // Background process trigger
            scrapeAndSave(); 
            
            return res.status(200).json({
                success: true,
                message: "✅ Titan Explorer Started. Website mapping in progress...",
                status: "MAPPING"
            });

        } catch (scraperError) {
            console.warn("⚠️ Scraper unavailable, loading Emergency Knowledge Graph.");
            throw new Error("Scraper Service Down");
        }

    } catch (error) {
        // 2. Fallback: Emergency Data (Agar Scraper na chale)
        // Ye data AI ko 'dumb' hone se bachata hai
        console.log("⚡ Injecting Critical Navigation Data...");

        const emergencyMap = [
            {
                title: "Monthly Statement",
                link: "https://www.rcmbusiness.com/Business/MonthlyStatement",
                section: "Business",
                guideSteps: ["Login to App", "Go to Menu", "Click 'My Business'", "Select 'Monthly Statement'"],
                keywords: ["income", "commission", "paisa", "statement", "check"],
                requiredFields: ["User ID", "Password"]
            },
            {
                title: "New Joining (KYC)",
                link: "https://www.rcmbusiness.com/Registration/NewUser",
                section: "Registration",
                guideSteps: ["Open Form", "Fill Personal Details", "Upload Aadhar & Pan", "Add Bank Details", "Submit OTP"],
                keywords: ["join", "new member", "id banana", "joining", "kyc"],
                requiredFields: ["Aadhar Card", "PAN Card", "Bank Passbook", "Photo"]
            },
            {
                title: "Forgot Password",
                link: "https://www.rcmbusiness.com/Login/ForgotPassword",
                section: "Security",
                guideSteps: ["Click Forgot Password", "Enter User ID", "Enter Registered Mobile", "Enter OTP", "Set New Password"],
                keywords: ["password reset", "bhul gaya", "login nahi ho raha"],
                requiredFields: ["User ID", "Mobile Number"]
            },
            {
                title: "Delivery Centers (PUC)",
                link: "https://www.rcmbusiness.com/World/DeliveryCenters",
                section: "Tools",
                guideSteps: ["Select State", "Select District", "Click Search"],
                keywords: ["shop", "dukan", "store", "pickup center", "puc"],
                requiredFields: ["State", "District"]
            }
        ];

        // Bulk Upsert
        for (const mapItem of emergencyMap) {
            await SiteMap.upsert(mapItem);
        }

        return res.status(200).json({
            success: true,
            message: "⚠️ Scraper Busy. Emergency Knowledge Graph Loaded.",
            topics: emergencyMap.length
        });
    }
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