const express = require('express');
const router = express.Router();
const { postDailyReport, getDailyReport } = require('../controllers/dailyReport.controller');

// ✅ Use 'verifyToken' (or 'isAuthenticated') AND 'isActiveUser'
const { verifyToken, isActiveUser } = require('../middleware/authMiddleware'); 

router.post('/post-dailyReport', verifyToken, isActiveUser, postDailyReport);
router.post('/get-dailyReport', verifyToken, isActiveUser, getDailyReport);

module.exports = router;