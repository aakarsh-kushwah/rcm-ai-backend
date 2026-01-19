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
// ============================================================
// 2. ACTIVE STATUS ENFORCER (Smart Subscription Check) 🛡️
// ============================================================
const isActiveUser = async (req, res, next) => {
    try {
        let userId = req.userId || req.user?.id;
        if (userId) userId = parseInt(userId, 10);

        if (!userId) {
            return res.status(401).json({ success: false, message: '🚫 Identity Verification Failed.' });
        }

        // 1. Fetch User with Billing Details
        const user = await User.findByPk(userId, {
            attributes: ['id', 'status', 'role', 'nextBillingDate', 'autoPayStatus'] 
        });

        if (!user) {
            return res.status(404).json({ success: false, message: '🚫 User Account Not Found.' });
        }

        // 2. ADMIN BYPASS (Admin ko payment ki zarurat nahi)
        if (user.role === 'ADMIN' || user.role === 'SUPPORT') {
            req.userStatus = user.status;
            req.userRole = user.role;
            return next();
        }

        // 3. BAN CHECK (Sabse pehle ye check karo)
        if (user.status === 'banned') {
            return res.status(403).json({ 
                success: false, 
                message: '🚫 Your account has been banned due to policy violation.' 
            });
        }

        // 4. 📅 SUBSCRIPTION EXPIRY CHECK (The Logic You Asked For)
        const currentDate = new Date();
        const billingDate = user.nextBillingDate ? new Date(user.nextBillingDate) : null;

        // Agar Billing Date null hai ya Beet chuki hai (Expired)
        // Aur status abhi bhi 'active' dikha raha hai, to use SUDHARO.
        if (!billingDate || billingDate < currentDate) {
            
            // Logically user expired hai, par DB me active hai. Ise fix karo.
            if (user.status === 'active' || user.status === 'premium') {
                console.log(`⚠️ [AUTO-DOWNGRADE] User ${userId} subscription expired on ${billingDate}. Downgrading...`);
                
                // DB Update (Lazy Update)
                await user.update({ 
                    status: 'pending', 
                    autoPayStatus: false 
                });
            }

            return res.status(403).json({ 
                success: false, 
                message: '⛔ Subscription Expired. Please renew to continue.',
                code: 'SUBSCRIPTION_REQUIRED' // Frontend ko signal dene ke liye
            });
        }

        // 5. Agar AutoPay OFF hai lekin Date abhi bachi hai -> Allow access (Grace Period logic)
        // (Optional: Aap chahein to yahan strict check laga sakte hain)

        // All Checks Passed
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