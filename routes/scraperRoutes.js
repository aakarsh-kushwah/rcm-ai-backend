/**
 * @file src/routes/utilRoutes.js
 * @description System Utilities & Scraper Triggers (Clean Architecture)
 */
const express = require('express');
const router = express.Router();

// Route: GET /api/scraper/fill-data
router.get('/fill-data', (req, res) => {
    res.status(503).json({
        success: false,
        code: 'LOCAL_WORKER_REQUIRED',
        status: 'OFFLOADED',
        message: 'RCM portal scraping runs in the local portal worker.',
    });
});

module.exports = router;