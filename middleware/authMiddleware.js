const jwt = require('jsonwebtoken');

// ✅ CORRECT IMPORT: We destructure { db } because your config exports { db, initialize }
// This keeps the reference to the 'db' object, which gets filled later.
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
        req.user = decoded;                     
        req.userId = decoded.id || decoded.userId;  
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
        const userId = req.userId || req.user?.id;

        if (!userId) {
            return res.status(401).json({ success: false, message: 'User verification failed.' });
        }

        // ✅ FIX: Access db.User HERE, inside the request.
        // By the time a user requests a page, the DB is definitely connected.
        const User = db.User;

        // Safety Check: If DB crashed or failed to load
        if (!User) {
            console.error("❌ Database Error: User model not loaded yet.");
            return res.status(500).json({ success: false, message: 'System initializing, please try again.' });
        }

        // Fetch fresh status
        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User account not found.' });
        }

        // 🛑 CRITICAL CHECK
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