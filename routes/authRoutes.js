const express = require('express');
// CRITICAL: Ensure adminSignup is included in the import list
const { register, login, adminSignup } = require('../controllers/authController'); 

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
// This is the line (likely line 8) that was throwing the error
router.post('/admin/signup', adminSignup); 

module.exports = router;