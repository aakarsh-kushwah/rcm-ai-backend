/**
 * @file src/controllers/authController.js
 * @description Titan Authentication Core (Google-Only Auth & Admin Gateway)
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const { User, Admin } = require("../models");
const { Op } = require("sequelize");
const { logger } = require("../utils/logger");
const crypto = require("crypto");

// ⚙️ CONFIGURATION
const JWT_ACCESS_EXPIRY = "1h";
const JWT_REFRESH_EXPIRY = "30d";
const SALT_ROUNDS = 10;

// Helper: Token Generator
const generateToken = (user, expiresIn) => {
    const parsedId = parseInt(user.id, 10);
    const tokenId = Number.isNaN(parsedId) ? user.id : parsedId;
    return jwt.sign(
        { 
            id: tokenId,
            role: user.role || "USER",
            status: user.status,
            isApproved: user.isApproved 
        }, 
        process.env.JWT_SECRET, 
        { expiresIn }
    );
};

// Helper: Generate a secure 6-digit verification code
const generateVerificationCode = () => {
    return crypto.randomInt(100000, 999999).toString();
};

// ============================================================
// 1. GOOGLE OAUTH LOGIN & ONBOARDING
// ============================================================
exports.googleAuthLogin = async (req, res) => {
    const { credential } = req.body;

    if (!credential) {
        return res.status(400).json({ success: false, message: "Google ID token (credential) is required." });
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const { email, name, picture, sub: googleId, email_verified } = payload;

        if (!email_verified) {
            logger.warn({ traceId: req.id, email }, "Google auth failed: Email not verified");
            return res.status(401).json({ success: false, message: "Google account email is not verified." });
        }

        // Find user by googleId or email
        let user = await User.findOne({
            where: {
                [Op.or]: [
                    { googleId: googleId },
                    { email: email.toLowerCase().trim() }
                ]
            }
        });

        if (user) {
            let updated = false;
            if (!user.googleId) {
                user.googleId = googleId;
                updated = true;
            }
            if (!user.avatar && picture) {
                user.avatar = picture;
                updated = true;
            }
            if (updated) {
                await user.save();
            }
        } else {
            user = await User.create({
                fullName: name || "Google User",
                email: email.toLowerCase().trim(),
                googleId: googleId,
                avatar: picture || null,
                status: "pending",
                autoPayStatus: false,
                nextBillingDate: null
            });
            logger.info({ traceId: req.id, userId: user.id }, "New user registered via Google OAuth");
        }

        if (user.status === "banned" || user.status === "suspended") {
            logger.warn({ traceId: req.id, userId: user.id }, "Google login attempt: Account suspended/banned");
            return res.status(403).json({ success: false, message: "🚫 Account Suspended. Contact Support." });
        }

        const accessToken = generateToken(user, JWT_ACCESS_EXPIRY);
        const refreshToken = generateToken(user, JWT_REFRESH_EXPIRY);

        logger.info({ traceId: req.id, userId: user.id, role: user.role }, "Google authentication successful");

        res.json({
            success: true,
            message: "Authentication successful!",
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                fullName: user.fullName,
                email: user.email,
                rcmId: user.rcmId,
                avatar: user.avatar,
                status: user.status,
                role: user.role,

            }
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Google Auth Verification Error");
        res.status(500).json({ success: false, message: "Google authentication failed.", error: error.message });
    }
};

// ============================================================
// 2. ADMIN SIGNUP (Secure Protocol)
// ============================================================
exports.adminSignup = async (req, res) => {
    const { fullName, email, phone, password } = req.body;

    try {
        const existingAdmin = await User.findOne({ where: { email } });
        if (existingAdmin) {
            logger.warn({ traceId: req.id, email }, "Admin signup attempt: Admin already exists");
            return res.status(409).json({ message: "Admin already exists." });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const isSuperAdmin = email.toLowerCase() === "rcmaiasistant@gmail.com";
        const verificationCode = generateVerificationCode();

        const admin = await User.create({
            fullName,
            email,
            phone,
            password: hashedPassword,
            role: "ADMIN",
            status: isSuperAdmin ? "active" : "pending",
            isApproved: isSuperAdmin ? true : false,
            verificationCode,
        });

        const masterNumber = "+917722923842";
        const message = `Titan Core Gateway: Verification request from ${email}. Code: ${verificationCode}`;
        console.log(`🔑 Admin Registration Verification Code for ${email}: ${verificationCode} (Gateway: WhatsApp removed)`);

        logger.info({ traceId: req.id, adminId: admin.id, email: admin.email }, "New admin registered, awaiting verification");

        res.status(202).json({
            success: true,
            message: "✅ Admin registration successful. Awaiting WhatsApp verification.",
            user: {
                id: admin.id,
                email: admin.email,
                role: admin.role,
                status: admin.status,
                isApproved: admin.isApproved
            }
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Admin Signup Error");
        res.status(500).json({ message: "System Error.", error: error.message });
    }
};

// ============================================================
// 3. REFRESH TOKEN (Automated)
// ============================================================
exports.refreshToken = async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, message: "Authorization token not provided." });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ success: false, message: "Token not found." });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRY });
        const user = await User.findByPk(decoded.id);

        if (!user) {
            logger.warn({ traceId: req.id, token }, "Refresh token failed: User not found");
            return res.status(404).json({ success: false, message: "User not found." });
        }

        if (user.role === "ADMIN" && !user.isApproved) {
            logger.warn({ traceId: req.id, userId: user.id }, "Refresh attempt: Admin account not approved");
            return res.status(403).json({ success: false, message: "🚫 Access Denied: Your admin account is pending approval." });
        }

        const newAccessToken = generateToken(user, JWT_ACCESS_EXPIRY);

        logger.info({ traceId: req.id, userId: user.id }, "Access token refreshed successfully");

        res.json({
            success: true,
            message: "Access token refreshed.",
            accessToken: newAccessToken,
            user: {
                id: user.id,
                fullName: user.fullName,
                email: user.email,
                rcmId: user.rcmId,
                status: user.status,
                role: user.role,

            },
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Refresh Token Error");
        return res.status(403).json({ success: false, message: "Invalid or expired token.", error: error.message });
    }
};

/**
 * @route   POST /api/auth/admin/verify
 * @desc    Verify Admin with code
 * @access  Public
 */
exports.adminVerify = async (req, res) => {
    const { email, code } = req.body;

    try {
        const admin = await User.findOne({ where: { email } });

        if (!admin) {
            logger.warn({ traceId: req.id, email }, "Admin verification failed: Admin not found");
            return res.status(404).json({ success: false, message: "Admin not found." });
        }

        if (admin.verificationCode !== code) {
            logger.warn({ traceId: req.id, email }, "Admin verification failed: Invalid code");
            return res.status(400).json({ success: false, message: "Invalid verification code." });
        }

        admin.status = "active";
        admin.isApproved = true;
        admin.verificationCode = null;
        await admin.save();

        const accessToken = generateToken(admin, JWT_ACCESS_EXPIRY);
        const refreshToken = generateToken(admin, JWT_REFRESH_EXPIRY);

        logger.info({ traceId: req.id, adminId: admin.id, email: admin.email }, "Admin account verified and activated");

        res.json({
            success: true,
            message: "✅ Admin account verified and activated.",
            accessToken,
            refreshToken,
            user: {
                id: admin.id,
                fullName: admin.fullName,
                email: admin.email,
                role: admin.role,
                status: admin.status,
                isApproved: admin.isApproved
            }
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Admin Verification Error");
        res.status(500).json({ success: false, message: "System Error during verification.", error: error.message });
    }
};

// ============================================================
// 4. ADMIN ZERO-TRUST AUTH (Phase 1: Google OAuth Verification)
// ============================================================
exports.adminGooglePhaseOne = async (req, res) => {
    const { credential } = req.body;

    if (!credential) {
        return res.status(400).json({ success: false, message: "Google ID token (credential) is required." });
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        console.log("DEBUG - Email from Google:", JSON.stringify(payload.email));
        const { email, email_verified } = payload;

        if (!email_verified) {
            logger.warn({ traceId: req.id, email }, "Admin Google Phase One failed: Email not verified");
            return res.status(401).json({ success: false, message: "Google account email is not verified." });
        }

        const admin = await Admin.findOne({
            where: { email: email.toLowerCase().trim() }
        });

        if (!admin) {
            logger.warn({ traceId: req.id, email }, "Admin Google Phase One: Admin record not found");
            return res.status(403).json({ success: false, message: "🚫 Access Denied: Admin record not found for this email in the Admin registry." });
        }

        if (!admin.isApproved) {
            logger.warn({ traceId: req.id, email }, "Admin Google Phase One: Admin not approved");
            return res.status(403).json({ success: false, message: "🚫 Access Denied: Admin account is pending approval." });
        }

        if (admin.status !== 'active') {
            logger.warn({ traceId: req.id, email, status: admin.status }, "Admin Google Phase One: Admin account not active");
            return res.status(403).json({ success: false, message: `🚫 Access Denied: Admin account status is '${admin.status}'.` });
        }

        const tempAdminToken = jwt.sign(
            { id: admin.id, email: admin.email, role: admin.role },
            process.env.JWT_SECRET,
            { expiresIn: "10m" }
        );

        logger.info({ traceId: req.id, adminId: admin.id }, "Admin Google Phase One successful, issued temp token");

        res.json({
            success: true,
            tempAdminToken,
            message: "Proceed to master password verification."
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Admin Google Phase One Error");
        res.status(500).json({ success: false, message: "Admin Google authentication failed.", error: error.message });
    }
};

// ============================================================
// 5. ADMIN ZERO-TRUST AUTH (Phase 2: Master Password Verification)
// ============================================================
exports.adminMasterPasswordPhaseTwo = async (req, res) => {
    const { tempToken, masterPassword } = req.body;

    if (!tempToken || !masterPassword) {
        return res.status(400).json({ success: false, message: "Temporary token and master password are required." });
    }

    try {
        const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
        const admin = await Admin.findByPk(decoded.id);

        if (!admin) {
            logger.warn({ traceId: req.id, adminId: decoded.id }, "Admin Phase 2: Admin not found");
            return res.status(403).json({ success: false, message: "🚫 Access Denied: Admin record not found." });
        }

        if (!admin.isApproved) {
            logger.warn({ traceId: req.id, adminId: decoded.id }, "Admin Phase 2: Admin not approved");
            return res.status(403).json({ success: false, message: "🚫 Access Denied: Admin account is not approved." });
        }

        if (admin.status !== 'active') {
            logger.warn({ traceId: req.id, adminId: decoded.id, status: admin.status }, "Admin Phase 2: Admin status not active");
            return res.status(403).json({ success: false, message: `🚫 Access Denied: Admin account status is '${admin.status}'.` });
        }

        const isMatch = await bcrypt.compare(masterPassword, admin.masterPassword);
        if (!isMatch) {
            logger.warn({ traceId: req.id, adminId: admin.id }, "Master password verification failed");
            return res.status(401).json({ success: false, message: "Invalid master password." });
        }

        const accessToken = generateToken(admin, JWT_ACCESS_EXPIRY);
        const refreshToken = generateToken(admin, JWT_REFRESH_EXPIRY);

        logger.info({ traceId: req.id, adminId: admin.id }, "Admin authenticated successfully via 2-step verification");

        res.json({
            success: true,
            message: "Admin authentication successful!",
            accessToken,
            refreshToken,
            admin: {
                id: admin.id,
                name: admin.name,
                email: admin.email,
                role: admin.role,
                status: admin.status,
                isApproved: admin.isApproved
            }
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Admin Master Password Verification Error");
        return res.status(403).json({ success: false, message: "Invalid or expired temporary session token.", error: error.message });
    }
};

