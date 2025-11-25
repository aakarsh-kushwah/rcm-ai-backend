const jwt = require('jsonwebtoken');

// ✅ Ye function main logic hai (ise hum dono naam se export karenge)
const verifyTokenLogic = (req, res, next) => {
    let token;
    
    // Case-insensitive header check
    const authHeader = req.headers.authorization || req.headers.Authorization;

    // Bearer token extract
    if (authHeader && authHeader.startsWith('Bearer')) {
        token = authHeader.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // ✅ Compatibility Layer (Purane aur Naye dono code ke liye data set karein)
        req.user = decoded;                         // Purane controllers (req.user.role) ke liye
        req.userId = decoded.id || decoded.userId;  // Naye controllers (req.userId) ke liye

        next();
    } catch (error) {
        console.error("Auth Error:", error.message);
        return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
};

const isAdmin = (req, res, next) => {
    // Role check (Admin or admin)
    if (req.user && (req.user.role === 'ADMIN' || req.user.role === 'admin')) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'Admin access required.' });
    }
};

// ============================================================
// ⭐️ MAGIC FIX YAHAN HAI
// ============================================================
module.exports = {
    // 1. Naye routes ke liye
    verifyToken: verifyTokenLogic, 

    // 2. Purane routes (Subscriber, User, etc.) ke liye
    // Hum 'isAuthenticated' ko bhi same logic point kar rahe hain
    isAuthenticated: verifyTokenLogic, 

    // 3. Admin middleware
    isAdmin
};