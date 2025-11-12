// routes/userRoutes.js

const express = require('express');
const router = express.Router();
// ✅ सिर्फ userController से इम्पोर्ट करें
const { getMyProfile } = require('../controllers/userController'); 
const { isAuthenticated } = require('../middleware/authMiddleware');

// ----------------------------------------------------------------
// 🛑 एरर फिक्स: यहाँ से 'deleteUser' और 'updateUserData' हटा दिया गया है
// ----------------------------------------------------------------

// ✅ यह रूट सिर्फ़ लॉग-इन यूज़र को उसका *अपना* प्रोफ़ाइल दिखाता है
// GET /api/users/me
router.get('/me', isAuthenticated, getMyProfile);

module.exports = router;