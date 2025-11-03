const jwt = require('jsonwebtoken');

// ✅ High-Traffic Handled: यह फ़ंक्शन JWT को पढ़कर सीधे req.user में यूजर डेटा (id, role) सेट करता है, 
// जिससे प्रत्येक रिक्वेस्ट पर डेटाबेस कॉल की आवश्यकता समाप्त हो जाती है। (बहुत तेज़)

const isAuthenticated = (req, res, next) => {
    let token;
    const authHeader = req.headers.authorization;
    
    // 1. Bearer Token की जाँच करें
    if (authHeader && authHeader.startsWith('Bearer')) {
        token = authHeader.split(' ')[1];
    } else {
        // टोकन प्रदान नहीं किया गया या गलत फॉर्मेट
        return res.status(401).json({ success: false, message: 'Authorization token is required and must be in Bearer format.' });
    }

    // 2. JWT Verification और Error Handling
    try {
        if (!token) {
             // दोबारा जाँच (वैसे तो ऊपर हैंडल हो चुका है, लेकिन सुरक्षा के लिए)
             throw new Error('No token found.');
        }
        
        // JWT को वेरिफाई करें
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // User Data को सीधे रिक्वेस्ट ऑब्जेक्ट से अटैच करें (Role के लिए जरूरी)
        req.user = decoded; 
        
        next(); 

    } catch (error) {
        // 'jwt malformed', 'jwt expired', 'invalid signature' जैसी त्रुटियों को हैंडल करें
        console.error('Token verification failed:', error.message);
        // 403 Forbidden का उपयोग करें (वैधता की कमी के लिए)
        return res.status(403).json({ success: false, message: `Not authorized, token failed: ${error.message}` });
    }
};

// 🛡️ Admin Access Middleware (isAuthenticated के बाद ही चलाएँ)
const isAdmin = (req, res, next) => {
    // req.user सीधे JWT से आ रहा है
    if (req.user && req.user.role === 'ADMIN') {
        next();
    } else {
        res.status(403).json({ success: false, message: 'Forbidden: Requires Admin privileges.' });
    }
};

module.exports = {
    isAuthenticated,
    isAdmin
};