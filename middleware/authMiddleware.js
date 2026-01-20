/**
 * @file src/middleware/authMiddleware.js
 * @description Titan Security Gatekeeper (Simplified Logic)
 */

const jwt = require('jsonwebtoken');
const { User } = require('../models');

// ============================================================
// 1. NEURAL TOKEN VALIDATOR (JWT Check)
// ============================================================
const verifyTokenLogic = (req, res, next) => {
    try {
        let token;
        const authHeader = req.headers.authorization || req.headers.Authorization;

        if (authHeader && authHeader.startsWith('Bearer')) {
            token = authHeader.split(' ')[1];
        }

        if (!token) {
            return res.status(401).json({ success: false, message: '🚫 Access Denied: Authentication Token Missing.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        req.userId = decoded.id || decoded.userId || decoded._id;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, message: '🚫 Session Expired. Please Login Again.' });
    }
};

// ============================================================
// 2. ACTIVE STATUS ENFORCER (Simplified: Status is Truth)
// ============================================================
const isActiveUser = async (req, res, next) => {
    try {
        let userId = req.userId || req.user?.id;
        if (userId) userId = parseInt(userId, 10);

        if (!userId) return res.status(401).json({ success: false, message: '🚫 Identity Verification Failed.' });

        // 1. Fetch User (Only Status Needed)
        const user = await User.findByPk(userId, {
            attributes: ['id', 'status', 'role']
        });

        if (!user) return res.status(404).json({ success: false, message: '🚫 User Not Found.' });

        // 2. ADMIN BYPASS
        if (user.role === 'ADMIN' || user.role === 'SUPPORT') {
            req.userStatus = user.status;
            req.userRole = user.role;
            return next();
        }

        // 3. BAN CHECK
        if (user.status === 'banned') {
            return res.status(403).json({ success: false, message: '🚫 Account Banned.' });
        }

        // 4. SIMPLE STATUS CHECK
        // Agar status 'active' ya 'premium' hai -> Access Granted
        // Agar 'pending' ya 'inactive' hai -> Access Denied
        if (user.status === 'active' || user.status === 'premium') {
            req.userStatus = user.status;
            req.userRole = user.role;
            next();
        } else {
            // Subscription Required
            return res.status(403).json({
                success: false,
                message: '⛔ Subscription Required. Please complete payment.',
                code: 'SUBSCRIPTION_REQUIRED'
            });
        }

    } catch (error) {
        console.error('🔥 [STATUS CHECK ERROR]:', error.message);
        res.status(500).json({ success: false, message: 'Internal Security Error.' });
    }
};

// ============================================================
// 3. ADMIN PRIVILEGE GUARD
// ============================================================
const isAdmin = (req, res, next) => {
    const role = req.user?.role || req.userRole;
    if (role && (role.toUpperCase() === 'ADMIN')) {
        next();
    } else {
        res.status(403).json({ success: false, message: '🚫 Access Denied: Admins Only.' });
    }
};

module.exports = {
    verifyToken: verifyTokenLogic,
    isAuthenticated: verifyTokenLogic,
    isActiveUser,
    isAdmin
};