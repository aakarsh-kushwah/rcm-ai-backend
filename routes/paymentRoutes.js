const express = require('express');
const router = express.Router();
const { createSubscription, verifyPayment } = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

// User must be logged in to subscribe
router.post('/create-subscription', protect, createSubscription);
router.post('/verify-payment', protect, verifyPayment);

module.exports = router;
