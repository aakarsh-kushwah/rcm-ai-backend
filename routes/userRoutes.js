// routes/userRoutes.js

const express = require('express');
const router = express.Router();

// ✅ Dono controllers ko import karein
const { 
    getMyProfile, 
    updateMyProfilePic // ⭐️ YEH NAYA HAI
} = require('../controllers/userController'); 

const { isAuthenticated } = require('../middleware/authMiddleware');

// GET /api/users/me
// Logged-in user ki profile data get karein
router.get('/me', isAuthenticated, getMyProfile);

// ⭐️ NAYA ROUTE (404 Error fix karne ke liye)
// PATCH /api/users/update-profile-pic
// Logged-in user ki profile pic update karein
router.patch('/update-profile-pic', isAuthenticated, updateMyProfilePic);

module.exports = router;