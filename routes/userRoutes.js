const express = require('express');
const router = express.Router();
// Assuming you import protect and isAdmin middleware
const { protect, isAdmin } = require('../middleware/authMiddleware'); 
const { deleteUser, updateUserData } = require('../controllers/userController'); // Import new functions

// Route for deleting a user (Requires Admin role)
router.delete('/:userId', protect, isAdmin, deleteUser); // ✅ NEW DELETE ROUTE

// Route for updating user data (Requires Admin role)
router.put('/:userId', protect, isAdmin, updateUserData); // ✅ NEW UPDATE ROUTE

module.exports = router;
