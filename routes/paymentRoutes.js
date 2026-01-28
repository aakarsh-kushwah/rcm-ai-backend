const express = require('express');
const router = express.Router();
const { createSubscription, verifyPayment } = require('../controllers/paymentController');

// ✅ 'protect' की जगह 'isAuthenticated' का इस्तेमाल करें (हैवी ट्रैफ़िक के लिए)
const { isAuthenticated } = require('../middleware/authMiddleware'); 

// User must be logged in to subscribe
router.post('/create-subscription', isAuthenticated, createSubscription);
router.post('/verify-payment', isAuthenticated, verifyPayment);

module.exports = router;
