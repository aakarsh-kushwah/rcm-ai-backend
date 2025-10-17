// backend/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { getRegularUsers, getAllAdmins } = require('../controllers/adminController'); 
const { protect, isAdmin } = require('../middleware/authMiddleware'); // Assuming this path is correct

// Route 1: Get Regular Users (Full path: /api/admin/users)
router.get('/users', protect, isAdmin, getRegularUsers);

// Route 2: Get Admins (Full path: /api/admin/admins)
router.get('/admins', protect, isAdmin, getAllAdmins);

module.exports = router;