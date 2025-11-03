const express = require('express');
const { handleChat, getAllChats, handleCalculate } = require('../controllers/chatController');
const { isAuthenticated, isAdmin } = require('../middleware/authMiddleware'); // (मान लिया कि आपके पास isAdmin है)

const router = express.Router();

// 1. AI चैट के लिए
router.post('/', isAuthenticated, handleChat);

// 2. कमीशन कैलकुलेटर के लिए (नया)
router.post('/calculate', isAuthenticated, handleCalculate);

// 3. एडमिन के लिए
// (सुरक्षा के लिए, 'isAuthenticated' की जगह 'isAdmin' का इस्तेमाल करें)
router.get('/all', isAuthenticated, isAdmin, getAllChats); 

module.exports = router;
