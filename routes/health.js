// Nayi file: routes/health.js
const express = require('express');
const router = express.Router();
const { db } = require('../config/db'); // Database import karein

/**
 * @route   GET /health
 * @desc    Server ko "sleep mode" se bachane ke liye UptimeRobot isse ping karega
 * @access  Public
 */
router.get('/health', async (req, res) => {
  try {
    // Database connection check karein
    await db.sequelize.authenticate();
    res.status(200).json({ status: 'UP', message: 'Server is awake and healthy!' });
  } catch (error) {
    res.status(503).json({ status: 'DOWN', message: 'Server is unhealthy', error: error.message });
  }
});

module.exports = router;