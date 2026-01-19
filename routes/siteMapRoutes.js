const express = require('express');
const router = express.Router();
const siteMapController = require('../controllers/siteMapController');

// 👇 Sitemap Route
router.get('/generate-live', siteMapController.generateSiteMapLive);

module.exports = router;