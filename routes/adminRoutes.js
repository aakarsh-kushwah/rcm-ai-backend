// routes/adminRoutes.js

const express = require('express');
const router = express.Router();

const { 
  getRegularUsers, 
  getAllAdmins,
  deleteUser,
  updateUserData 
} = require('../controllers/adminController');

const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');

// 🔐 Protect all admin routes
router.use(isAuthenticated, isAdmin);

// ================================
// USERS
// ================================

// ✅ Get all non-admin users
// URL: GET /api/admin/users
router.get('/users', getRegularUsers);

// 🔁 OPTIONAL ALIAS (for chat UI compatibility)
// URL: GET /api/chat/all
router.get('/chat/all', getRegularUsers);

// ================================
// ADMINS
// ================================

// URL: GET /api/admin/admins
router.get('/admins', getAllAdmins);

// ================================
// DELETE USER
// ================================

// URL: DELETE /api/admin/users/:userId
router.delete('/users/:userId', deleteUser);

// ================================
// UPDATE USER
// ================================

// URL: PATCH /api/admin/users/:userId
router.patch('/users/:userId', updateUserData);

module.exports = router;
