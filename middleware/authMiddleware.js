const jwt = require('jsonwebtoken');
// 🛑 नोट: 'db' की अब यहाँ ज़रूरत नहीं है, जो इसे और तेज़ बनाता है
// const { db } = require('../config/db');

// ✅ हाई-ट्रैफ़िक के लिए ऑप्टिमाइज़्ड
// यह मिडलवेयर अब डेटाबेस को हिट नहीं करता है।
const isAuthenticated = (req, res, next) => {
    let token;
    
    // 1. Authorization हेडर से टोकन लें
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];

            // 2. टोकन को वेरिफाई करें
            // यह 'decoded' हमें वह सब कुछ देता है जो हमने लॉगिन के समय साइन किया था
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // 3. ✅ decoded पेलोड को सीधे req.user पर अटैच करें
            // (हम मानते हैं कि decoded में { id: 1, role: 'USER' } है)
            // यही वह स्टेप है जो डेटाबेस कॉल को बचाता है
            req.user = decoded;

            next(); // सब ठीक है, अगले फ़ंक्शन पर जाएँ

        } catch (error) {
            console.error('Token verification failed:', error.message);
            return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authorized, no token' });
    }
};

// यह फ़ंक्शन पहले से ही ऑप्टिमाइज़ है क्योंकि यह 'req.user' का इस्तेमाल करता है
const isAdmin = (req, res, next) => {
    // 'req.user' अब सीधे टोकन से आ रहा है (तेज़)
    if (req.user && req.user.role === 'ADMIN') {
        next();
    } else {
        res.status(403).json({ success: false, message: 'Not authorized as an admin' });
    }
};

module.exports = {
    isAuthenticated,
    isAdmin
};

