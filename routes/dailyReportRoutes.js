const express = require('express');
const router = express.Router();
const { postDailyReport, getDailyReport } = require('../controllers/dailyReport.controller');
const { verifyToken } = require('../middleware/authMiddleware'); // नाम चेक करें

// 👇 ये पाथ बिल्कुल सही होने चाहिए
router.post('/post-dailyReport', verifyToken, postDailyReport);
router.post('/get-dailyReport', verifyToken, getDailyReport);

module.exports = router;