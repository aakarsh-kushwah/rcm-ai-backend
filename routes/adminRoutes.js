// routes/adminRoutes.js

const express = require('express');
const router = express.Router();
const { 
  getRegularUsers, 
  getAllAdmins,
  deleteUser,  // <-- deleteUser यहाँ है
  updateUserData 
} = require('../controllers/adminController'); // ✅ सही कंट्रोलर से इम्पोर्ट
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware');

router.use(isAuthenticated, isAdmin);

router.get('/users', getRegularUsers);
router.get('/admins', getAllAdmins);

// DELETE /api/admin/users/:userId
router.delete('/users/:userId', deleteUser); // <-- यह यहाँ सही है

// PATCH /api/admin/users/:userId
router.patch('/users/:userId', updateUserData);

module.exports = router;