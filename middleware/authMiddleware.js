const jwt = require('jsonwebtoken');

// ✅ CORRECT IMPORT: Reference to the 'db' object which gets filled later.
const { db } = require('../config/db'); 

// ============================================================
// 1. CORE AUTH LOGIC (Verifies Token)
// ============================================================
const verifyTokenLogic = (req, res, next) => {
    let token;
    
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (authHeader && authHeader.startsWith('Bearer')) {
        token = authHeader.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // 👇 DEBUGGING: Check what's inside the token
        // console.log("🔍 Decoded Token:", decoded);

        req.user = decoded; 
        
        // Handle various payload structures (id, userId, _id)
        req.userId = decoded.id || decoded.userId || decoded._id; 
        
        next();
    } catch (error) {
        console.error("Auth Error:", error.message);
        return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
};

// ============================================================
// 2. ACTIVE STATUS CHECK (The New Security Layer)
// ============================================================
const isActiveUser = async (req, res, next) => {
    try {
        let userId = req.userId || req.user?.id;

        // 🛠️ FIX: Ensure ID is an Integer before querying DB
        // If the token has "123" (string), we convert it to 123 (int)
        if (userId) {
            userId = parseInt(userId, 10);
        }

        // 👇 DEBUGGING: See what ID we are searching for
        // console.log(`🔎 Checking Active Status for User ID: ${userId}`);

        if (!userId) {
            return res.status(401).json({ success: false, message: 'User verification failed (Invalid ID).' });
        }

        // ✅ FIX: Access db.User inside the request
        const User = db.User;

        // Safety Check: If DB crashed or failed to load
        if (!User) {
            console.error("❌ Database Error: User model not loaded yet.");
            return res.status(500).json({ success: false, message: 'System initializing, please try again.' });
        }

        // Fetch fresh status from DB
        const user = await User.findByPk(userId);

        if (!user) {
            console.log(`❌ User ID ${userId} not found in Database.`);
            return res.status(404).json({ success: false, message: 'User account not found.' });
        }

        // 🛑 CRITICAL CHECK
        // If status is not explicitly 'active', treat as inactive (or pending)
        if (user.status !== 'active') {
            return res.status(403).json({ 
                success: false, 
                message: 'Subscription Inactive. Please renew.',
                code: 'SUBSCRIPTION_REQUIRED' 
            });
        }

        next(); 
    } catch (error) {
        console.error('Status Check Error:', error);
        res.status(500).json({ success: false, message: 'Server error checking subscription status.' });
    }
};

// ============================================================
// 3. ADMIN CHECK
// ============================================================
const isAdmin = (req, res, next) => {
    // Case-insensitive check for robustness
    if (req.user && (req.user.role === 'ADMIN' || req.user.role === 'admin')) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'Admin access required.' });
    }
};

module.exports = {
    verifyToken: verifyTokenLogic,    
    isAuthenticated: verifyTokenLogic, 
    isActiveUser,                     
    isAdmin
};