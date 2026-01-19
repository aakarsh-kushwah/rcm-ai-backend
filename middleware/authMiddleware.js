/**
 * @file src/middleware/authMiddleware.js
 * @description Titan Security Gatekeeper (ASI Level 5)
 * @capabilities JWT Validation, Role-Based Access Control (RBAC), Subscription Enforcer
 * @performance Optimized for High-Concurrency (Non-Blocking)
 */

const jwt = require('jsonwebtoken');
// ✅ CORRECT IMPORT: Importing directly from the Central Titan Loader
const { User } = require('../models'); 

// ============================================================
// 1. NEURAL TOKEN VALIDATOR (JWT Check)
// ============================================================
const verifyTokenLogic = (req, res, next) => {
    try {
        let token;
        const authHeader = req.headers.authorization || req.headers.Authorization;

        // 1. Extract Token smartly
        if (authHeader && authHeader.startsWith('Bearer')) {
            token = authHeader.split(' ')[1];
        }

        if (!token) {
            return res.status(401).json({ 
                success: false, 
                message: '🚫 Access Denied: Authentication Token Missing.' 
            });
        }

        // 2. Verify Signature
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // 3. Attach User Identity to Request
        req.user = decoded;
        // Support multiple ID formats (Titan Engine Standard)
        req.userId = decoded.id || decoded.userId || decoded._id;

        next();

    } catch (error) {
        console.warn(`⚠️ [AUTH BLOCKED] Invalid Token Attempt: ${error.message}`);
        return res.status(403).json({ 
            success: false, 
            message: '🚫 Session Expired or Invalid Token. Please Login Again.' 
        });
    }
};

// ============================================================
// 2. ACTIVE STATUS ENFORCER (The Subscription Shield)
// ============================================================
const isActiveUser = async (req, res, next) => {
    try {
        let userId = req.userId || req.user?.id;

        // 1. Input Sanitization (Integer Check)
        if (userId) userId = parseInt(userId, 10);

        if (!userId) {
            return res.status(401).json({ success: false, message: '🚫 Identity Verification Failed.' });
        }

        // 2. SAFETY CHECK: Ensure Titan Engine Loaded the Model
        if (!User) {
            console.error("❌ [CRITICAL] User Model Not Loaded in Middleware.");
            return res.status(503).json({ 
                success: false, 
                message: '⏳ System initializing. Please retry in 5 seconds.' 
            });
        }

        // 3. PERFORMANCE QUERY (Select only necessary fields)
        // Hum puri profile load nahi karenge, sirf status check karenge (Ultra Fast)
        const user = await User.findByPk(userId, {
            attributes: ['id', 'status', 'role'] 
        });

        // 4. Validation Logic
        if (!user) {
            return res.status(404).json({ success: false, message: '🚫 User Account Not Found.' });
        }

        if (user.status !== 'active') {
            return res.status(403).json({ 
                success: false, 
                message: '⛔ Subscription Inactive. Access Restricted.',
                code: 'SUBSCRIPTION_REQUIRED'
            });
        }

        // Attach fresh role/status to request (for downstream use)
        req.userStatus = user.status;
        req.userRole = user.role;

        next(); 

    } catch (error) {
        console.error('🔥 [STATUS CHECK ERROR]:', error.message);
        res.status(500).json({ success: false, message: 'Internal Security Error.' });
    }
};

// ============================================================
// 3. ADMIN PRIVILEGE GUARD
// ============================================================
const isAdmin = (req, res, next) => {
    // Robust Case-Insensitive Check
    const role = req.user?.role || req.userRole;
    
    if (role && (role.toUpperCase() === 'ADMIN')) {
        next();
    } else {
        console.warn(`⚠️ [SECURITY ALERT] Unauthorized Admin Access Attempt by User ID: ${req.userId}`);
        res.status(403).json({ success: false, message: '🚫 Access Denied: Titan Administrators Only.' });
    }
};

// ============================================================
// 4. MODULE EXPORTS
// ============================================================
module.exports = {
    verifyToken: verifyTokenLogic,    
    isAuthenticated: verifyTokenLogic, // Alias for backward compatibility
    isActiveUser,                     
    isAdmin
};