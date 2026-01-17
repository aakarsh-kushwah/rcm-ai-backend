/**
 * @file src/routes/utilRoutes.js
 * @description System Utilities & Scraper Triggers (Clean Architecture)
 */
const express = require('express');
const router = express.Router();
const { scrapeAndSave } = require('../services/rcmScraper'); // Apni service file ka naam check karein

// Route: GET /api/utils/fill-data
router.get('/fill-data', async (req, res) => {
    console.log("⚡ Scraper Triggered via API...");
    
    // Background me process start karo (User ko wait mat karao)
    scrapeAndSave().catch(err => console.error("Scraper Error:", err));
    
    res.json({ 
        success: true, 
        message: "✅ Command Received. Scraper background me start ho gaya hai." 
    });
});

module.exports = router;