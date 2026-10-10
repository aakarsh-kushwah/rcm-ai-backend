/**
 * @file src/middleware/authMiddleware.js
 * @description Titan Security Gatekeeper (Simplified Logic)
 */

const jwt = require('jsonwebtoken');
const { logger } = require('../utils/logger'); // Add logger import
const { User, Admin } = require('../models'); 
const { connection: redis } = require('../config/redis'); // Redis connection for active user tracking

// ============================================================
// 1. NEURAL TOKEN VALIDATOR (JWT Check)
// ============================================================
const verifyTokenLogic = (req, res, next) => {
    logger.info('[AuthMiddleware] verifyTokenLogic: Starting token verification.');
    try {
        let token = req.headers.authorization?.split(' ')[1] || req.headers.Authorization?.split(' ')[1];

        if (!token && req.cookies) {
            token = req.cookies.token || req.cookies.accessToken || req.cookies.refreshToken;
        }

        if (!token) {
            logger.warn('[AuthMiddleware] verifyTokenLogic: No authentication token found.');
            return res.status(401).json({ success: false, message: '🚫 Access Denied: Authentication Token Missing.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        req.userId = decoded.id || decoded.userId || decoded._id;

        // Task 4.1: Track active user in Redis (TTL: 2 minutes)
        if (req.userId) {
            redis.setex(`active_user:${req.userId}`, 120, 'online').catch(() => {});
        }

        logger.info(`[AuthMiddleware] verifyTokenLogic: Token decoded for user ID: ${req.userId}, role: ${req.user.role}`);
        next();
    } catch (error) {
        logger.error({ err: error.message }, '[AuthMiddleware] verifyTokenLogic: Token verification failed.');
        return res.status(403).json({ success: false, message: '🚫 Session Expired. Please Login Again.' });
    }
};

// ============================================================
// 2. ACTIVE STATUS ENFORCER (Simplified: Status is Truth)
// ============================================================
const isActiveUser = async (req, res, next) => {
    logger.info('[AuthMiddleware] isActiveUser: Starting active user check.');
    try {
        let userId = req.userId || req.user?.id;
        if (userId) {
            const parsed = parseInt(userId, 10);
            userId = Number.isNaN(parsed) ? userId : parsed;
        }

        if (!userId) {
            logger.warn('[AuthMiddleware] isActiveUser: No userId found in request.');
            return res.status(401).json({ success: false, message: '🚫 Identity Verification Failed.' });
        }

        logger.info(`[AuthMiddleware] isActiveUser: Checking status for user ID: ${userId}, token role: ${req.user?.role}`);

        const tokenRole = (req.user?.role || '').toUpperCase();
        if (tokenRole === 'ADMIN' || tokenRole === 'SUPER_ADMIN' || tokenRole === 'SUPERADMIN' || req.user?.isAdmin) {
            logger.info(`[AuthMiddleware] isActiveUser: User is an admin, checking Admin model.`);
            if (!Admin) {
                console.error("🔥 CRITICAL: Admin model undefined in Middleware");
                return res.status(500).json({ success: false, message: 'System Error: Admin DB Model Missing.' });
            }
            const admin = await Admin.findByPk(userId, {
                attributes: ['id', 'status', 'role', 'isApproved']
            });
            if (!admin) {
                logger.warn(`[AuthMiddleware] isActiveUser: Admin with ID ${userId} not found.`);
                return res.status(404).json({ success: false, message: '🚫 Admin Not Found.' });
            }
            if (!admin.isApproved || admin.status !== 'active') {
                logger.warn(`[AuthMiddleware] isActiveUser: Admin ${userId} account pending approval or inactive. Status: ${admin.status}, Approved: ${admin.isApproved}`);
                return res.status(403).json({ success: false, message: '🚫 Admin Account Pending Approval or Inactive.' });
            }
            req.userStatus = admin.status;
            req.userRole = admin.role;
            logger.info(`[AuthMiddleware] isActiveUser: Admin ${userId} is active and approved. Role: ${admin.role}`);
            return next();
        }

        if (!User) {
            console.error("🔥 CRITICAL: User model undefined in Middleware");
            return res.status(500).json({ success: false, message: 'System Error: DB Model Missing.' });
        }

        const user = await User.findByPk(userId, {
            attributes: ['id', 'status', 'role']
        });

        if (!user) {
            logger.warn(`[AuthMiddleware] isActiveUser: User with ID ${userId} not found.`);
            return res.status(404).json({ success: false, message: '🚫 User Not Found.' });
        }

        const userRole = (user.role || '').toUpperCase();
        if (userRole === 'ADMIN' || userRole === 'SUPPORT' || user.isAdmin) {
            logger.info(`[AuthMiddleware] isActiveUser: User ${userId} has role ${userRole}, bypassing further checks.`);
            if (userRole === 'ADMIN' && (!user.isApproved || user.status !== 'active')) {
                logger.warn(`[AuthMiddleware] isActiveUser: User-Admin ${userId} account pending approval or inactive. Status: ${user.status}, Approved: ${user.isApproved}`);
                return res.status(403).json({ success: false, message: '🚫 Admin Account Pending Approval or Inactive.' });
            }
            req.userStatus = user.status;
            req.userRole = user.role;
            return next();
        }

        if (user.status === 'banned' || user.status === 'suspended') {
            logger.warn(`[AuthMiddleware] isActiveUser: User ${userId} is banned or suspended. Status: ${user.status}`);
            return res.status(403).json({ success: false, message: '🚫 User is banned or suspended.' });
        }

        // Allow 'active', 'premium', or 'pending' for specific routes
        const shortsRoutes = ["/api/shorts/feed", "/api/shorts/seen"];
        const isShortsRoute = shortsRoutes.some(route => req.path.startsWith(route));

        if (isShortsRoute) {
            if (user.status === "active" || user.status === "premium" || user.status === "pending") {
                req.userStatus = user.status;
                req.userRole = user.role;
                logger.info(`[AuthMiddleware] isActiveUser: User ${userId} accessing shorts route with status: ${user.status}`);
                next();
            } else {
                logger.warn(`[AuthMiddleware] isActiveUser: User ${userId} attempted shorts route access with status: ${user.status}. Access denied.`);
                return res.status(403).json({ success: false, message: '🚫 Access denied for this user status for shorts routes.' });
            }
        } else {
            // Existing logic for other routes: only 'active' or 'premium' users can access
            if (user.status === 'active' || user.status === 'premium') {
                req.userStatus = user.status;
                req.userRole = user.role;
                logger.info(`[AuthMiddleware] isActiveUser: User ${userId} is active/premium. Status: ${user.status}`);
                next();
            } else {
                logger.warn(`[AuthMiddleware] isActiveUser: User ${userId} requires subscription for route ${req.path}. Status: ${user.status}`);
                return res.status(403).json({
                    success: false,
                    message: '⛔ Subscription Required. Please complete payment.',
                    code: 'SUBSCRIPTION_REQUIRED'
                });
            }
        }

    } catch (error) {
        logger.error({ err: error.message, stack: error.stack }, '[AuthMiddleware] isActiveUser: Internal security error.');
        res.status(500).json({ success: false, message: 'Internal Security Error.' });
    }
};

// ============================================================
// 3. ADMIN PRIVILEGE GUARD (Legacy)
// ============================================================
const isAdmin = (req, res, next) => {
    const role = (req.user?.role || req.userRole || '').toUpperCase();
    if (role && (role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'SUPERADMIN' || req.user?.isAdmin)) {
        return next();
    } else {
        return res.status(403).json({ success: false, message: '🚫 Access Denied: Admins Only.' });
    }
};

// ============================================================
// 4. RBAC ROLE RESTRICTOR (Modern)
// ============================================================
const restrictTo = (...roles) => {
    return (req, res, next) => {
        logger.info(`[AuthMiddleware] restrictTo: Checking role restriction for user ID: ${req.userId}, required roles: [${roles.join(', ')}]`);
        const userRole = (req.user?.role || req.userRole || '').toUpperCase();
        const allowedRoles = roles.map(r => r.toUpperCase());
        if (!allowedRoles.includes(userRole) && !(req.user?.isAdmin && allowedRoles.includes('ADMIN'))) {
            logger.warn(`[AuthMiddleware] restrictTo: Access denied for user ID: ${req.userId} with role ${userRole}. Required roles: [${roles.join(', ')}]`);
            return res.status(403).json({
                success: false,
                message: `🚫 Access Denied: Required roles: [${roles.join(', ')}]`
            });
        }
        logger.info(`[AuthMiddleware] restrictTo: Access granted for user ID: ${req.userId} with role ${userRole}.`);
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
