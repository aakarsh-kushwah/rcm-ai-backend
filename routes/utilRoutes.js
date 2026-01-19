/**
 * @file routes/utilRoutes.js
 * @description System Utilities & Background Task Triggers
 * @capability Concurrency Control, Scraper Management, System Health
 */

const express = require('express');
const router = express.Router();
const { scrapeAndSave } = require('../services/rcmScraper'); // Scraper Service import

// 🔒 GLOBAL LOCK (Concurrency Control)
// Ye variable memory me rahega. Agar ye 'true' hai, to dusra scraper start nahi hoga.
// Isse server 50 Crore users hone par bhi hang nahi hoga.
let isScrapingRunning = false;

// ============================================================
// 1. ⚡ TRIGGER SCRAPER (Background Task)
// ============================================================
// URL: http://localhost:10000/api/utils/fill-data
router.get('/fill-data', async (req, res) => {
    
    // Step 1: Check Lock
    if (isScrapingRunning) {
        console.warn("⚠️ Scraper Trigger Ignored: Previous task still running.");
        return res.status(429).json({
            success: false,
            message: "✋ System Busy! Scraper is already running. Please wait...",
            status: "BUSY"
        });
    }

    // Step 2: Lock System & Respond Immediately
    isScrapingRunning = true;
    console.log("⚡ Command Received: Initiating Titan Explorer...");

    // User ko wait mat karao, turant success bolo
    res.json({
        success: true,
        message: "✅ Command Accepted. Scraper started in background.",
        status: "STARTED"
    });

    // Step 3: Run Heavy Task in Background (Fire & Forget)
    // Ye line response bhejne ke baad bhi chalti rahegi
    scrapeAndSave()
        .then(() => {
            console.log("✅ [BACKGROUND] Scraper Task Completed Successfully.");
            isScrapingRunning = false; // Lock Open
        })
        .catch((err) => {
            console.error("❌ [BACKGROUND] Scraper Failed:", err.message);
            isScrapingRunning = false; // Lock Open (even on error)
        });
});

// ============================================================
// 2. 💓 SYSTEM STATUS (Scraper Status Check)
// ============================================================
// URL: http://localhost:10000/api/utils/status
router.get('/status', (req, res) => {
    res.json({
        success: true,
        system: "Titan Engine Gen-6",
        scraperStatus: isScrapingRunning ? "RUNNING" : "IDLE",
        serverTime: new Date().toISOString()
    });
});

module.exports = router;