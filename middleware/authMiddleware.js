/**
 * @file src/middleware/authMiddleware.js
 * @description Titan Security Gatekeeper (Simplified Logic)
 */

const jwt = require('jsonwebtoken');
// ✅ FIX: Properly destructure User from the models export
const { User, Admin } = require('../models'); 

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
        // ✅ FIX: Handle UUID vs Integer user IDs properly (Admin/User tables may use UUID or numeric IDs)
        if (userId) {
            const parsed = parseInt(userId, 10);
            userId = Number.isNaN(parsed) ? userId : parsed;
        }

        if (!userId) return res.status(401).json({ success: false, message: '🚫 Identity Verification Failed.' });

        // ✅ ADMIN BRANCH: If JWT role indicates Admin/Super Admin, query Admin table instead of User table to prevent 404
        const tokenRole = req.user?.role;
        if (tokenRole === 'ADMIN' || tokenRole === 'SUPER_ADMIN') {
            if (!Admin) {
                console.error("🔥 CRITICAL: Admin model undefined in Middleware");
                return res.status(500).json({ success: false, message: 'System Error: Admin DB Model Missing.' });
            }
            const admin = await Admin.findByPk(userId, {
                attributes: ['id', 'status', 'role', 'isApproved']
            });
            if (!admin) return res.status(404).json({ success: false, message: '🚫 Admin Not Found.' });
            if (!admin.isApproved || admin.status !== 'active') {
                return res.status(403).json({ success: false, message: '🚫 Admin Account Pending Approval or Inactive.' });
            }
            req.userStatus = admin.status;
            req.userRole = admin.role;
            return next();
        }

        // ✅ FIX: Ensure User model is available
        if (!User) {
            console.error("🔥 CRITICAL: User model undefined in Middleware");
            return res.status(500).json({ success: false, message: 'System Error: DB Model Missing.' });
        }

        // 1. Fetch User (Only Status Needed)
        const user = await User.findByPk(userId, {
            attributes: ['id', 'status', 'role', 'isApproved']
        });

        if (!user) return res.status(404).json({ success: false, message: '🚫 User Not Found.' });

        // 2. ADMIN BYPASS & APPROVAL CHECK
        if (user.role === 'ADMIN' || user.role === 'SUPPORT') {
            if (user.role === 'ADMIN' && (!user.isApproved || user.status !== 'active')) {
                return res.status(403).json({ success: false, message: '🚫 Admin Account Pending Approval or Inactive.' });
            }
            req.userStatus = user.status;
            req.userRole = user.role;
            return next();
        }

        // 3. BAN CHECK
        if (user.status === 'banned') {
            return res.status(403).json({ success: false, message: '🚫 Account Banned.' });
        }

        // 4. SIMPLE STATUS CHECK
        if (user.status === 'active' || user.status === 'premium') {
            req.userStatus = user.status;
            req.userRole = user.role;
            next();
        } else {
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
// 3. ADMIN PRIVILEGE GUARD (Legacy)
// ============================================================
const isAdmin = (req, res, next) => {
    const role = req.user?.role || req.userRole;
    if (role && (role.toUpperCase() === 'ADMIN' || role.toUpperCase() === 'SUPER_ADMIN')) {
        next();
    } else {
        res.status(403).json({ success: false, message: '🚫 Access Denied: Admins Only.' });
    }
};

// ============================================================
// 4. RBAC ROLE RESTRICTOR (Modern)
// ============================================================
const restrictTo = (...roles) => {
    return (req, res, next) => {
        const userRole = req.user?.role || req.userRole;
        if (!roles.includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: `🚫 Access Denied: Required roles: [${roles.join(', ')}]`
            });
        }
        next();
    };
};

module.exports = {
    verifyToken: verifyTokenLogic,
    isAuthenticated: verifyTokenLogic,
    isActiveUser,
    isAdmin,
    restrictTo
};