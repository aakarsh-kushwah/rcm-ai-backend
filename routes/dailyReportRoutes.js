const express = require('express');
const router = express.Router();
const controller = require('../controllers/dailyReport.controller');

// 👇 IMP: Agar aapke folder ka naam 'middlewares' (s ke sath) hai, toh path badal dein
// Abhi ye 'middleware' folder dhund raha hai.
const { verifyToken } = require('../middleware/authMiddleware'); 

// --- Final Debug Check ---
if (!verifyToken) {
    console.error("❌ ABHI BHI ERROR: Path galat hai! '../middleware' vs '../middlewares' check karein.");
}

router.post('/post-dailyReport', verifyToken, controller.postDailyReport);
router.post('/get-dailyReport', verifyToken, controller.getDailyReport);

module.exports = router;