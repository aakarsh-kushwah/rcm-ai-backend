const express = require('express');
const { getAllUsers } = require('../controllers/userController');
const { protect, isAdmin } = require('../middleware/authMiddleware');
const router = express.Router();

// सिर्फ एडमिन ही सभी यूज़र्स को देख सकता है
router.get('/', protect, isAdmin, getAllUsers);

module.exports = router;