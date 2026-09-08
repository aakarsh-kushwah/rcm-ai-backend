/**
 * @file src/controllers/authController.js
 * @description Titan Authentication Core (Opaque Refresh Tokens, Rotation, Reuse Detection, HttpOnly Cookies)
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const { User, Admin, RefreshToken } = require("../models");
const { Op } = require("sequelize");
const { logger } = require("../utils/logger");
const crypto = require("crypto");

// ⚙️ CONFIGURATION
const JWT_ACCESS_EXPIRY = "1h";
const SALT_ROUNDS = 10;
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
};

// Helper: Token Generator (Access Token JWT)
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

// Helper: Generate Opaque Refresh Token & Store Hash in DB
const generateOpaqueRefreshToken = async (userId, adminId, userType, userAgent) => {
    const rawToken = crypto.randomBytes(40).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await RefreshToken.create({
        userId: userId || null,
        adminId: adminId || null,
        userType: userType || "USER",
        tokenHash,
        expiresAt,
        userAgent: userAgent || null
    });

    return rawToken;
};

// Helper: Generate a secure 6-digit verification code
const generateVerificationCode = () => {
    return crypto.randomInt(100000, 999999).toString();
};

// ============================================================
// 1. GOOGLE OAUTH LOGIN & ONBOARDING (User)
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
        const refreshTokenVal = await generateOpaqueRefreshToken(user.id, null, "USER", req.headers["user-agent"]);

        // Set HttpOnly Cookie
        res.cookie("refreshToken", refreshTokenVal, COOKIE_OPTIONS);

        logger.info({ traceId: req.id, userId: user.id, role: user.role }, "Google authentication successful");

        res.json({
            success: true,
            message: "Authentication successful!",
            accessToken,
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

        logger.info({ traceId: req.id, adminId: admin.id, email: admin.email }, "New admin registered, awaiting verification");

        res.status(202).json({
            success: true,
            message: "✅ Admin registration successful. Awaiting verification.",
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
// 3. REFRESH TOKEN (Automated User Rotation & Reuse Detection)
// ============================================================
exports.refreshToken = async (req, res) => {
    const rawToken = req.cookies?.refreshToken;

    if (!rawToken) {
        return res.status(401).json({ success: false, message: "Refresh token not provided in cookie." });
    }

    try {
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const tokenRecord = await RefreshToken.findOne({ where: { tokenHash, userType: "USER" } });

        if (!tokenRecord) {
            logger.warn({ traceId: req.id }, "Refresh token not found in DB");
            return res.status(401).json({ success: false, message: "Invalid or expired refresh token." });
        }

        if (tokenRecord.expiresAt < new Date()) {
            await tokenRecord.update({ revokedAt: new Date() });
            return res.status(401).json({ success: false, message: "Refresh token expired." });
        }

        // Reuse Detection: If already revoked, compromise suspected! Revoke all user tokens.
        if (tokenRecord.revokedAt) {
            logger.error({ traceId: req.id, userId: tokenRecord.userId }, "🚨 Refresh Token Reuse Detected! Revoking all sessions.");
            await RefreshToken.update(
                { revokedAt: new Date() },
                { where: { userId: tokenRecord.userId, userType: "USER", revokedAt: null } }
            );
            res.clearCookie("refreshToken", COOKIE_OPTIONS);
            return res.status(401).json({ success: false, message: "Security Alert: Token reuse detected. All sessions revoked." });
        }

        const user = await User.findByPk(tokenRecord.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        // Rotate: Revoke current token
        await tokenRecord.update({ revokedAt: new Date() });

        // Issue new access token and new opaque refresh token
        const newAccessToken = generateToken(user, JWT_ACCESS_EXPIRY);
        const newRefreshTokenVal = await generateOpaqueRefreshToken(user.id, null, "USER", req.headers["user-agent"]);

        res.cookie("refreshToken", newRefreshTokenVal, COOKIE_OPTIONS);

        logger.info({ traceId: req.id, userId: user.id }, "User access token refreshed successfully with rotation");

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

// ============================================================
// 3.1. ADMIN REFRESH TOKEN (Automated Admin Rotation & Reuse Detection)
// ============================================================
exports.adminRefresh = async (req, res) => {
    const rawToken = req.cookies?.refreshToken;

    if (!rawToken) {
        return res.status(401).json({ success: false, message: "Admin refresh token not provided in cookie." });
    }

    try {
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const tokenRecord = await RefreshToken.findOne({ where: { tokenHash, userType: "ADMIN" } });

        if (!tokenRecord) {
            return res.status(401).json({ success: false, message: "Invalid or expired admin refresh token." });
        }

        if (tokenRecord.expiresAt < new Date()) {
            await tokenRecord.update({ revokedAt: new Date() });
            return res.status(401).json({ success: false, message: "Admin refresh token expired." });
        }

        if (tokenRecord.revokedAt) {
            logger.error({ traceId: req.id, adminId: tokenRecord.adminId }, "🚨 Admin Refresh Token Reuse Detected! Revoking all sessions.");
            await RefreshToken.update(
                { revokedAt: new Date() },
                { where: { adminId: tokenRecord.adminId, userType: "ADMIN", revokedAt: null } }
            );
            res.clearCookie("refreshToken", COOKIE_OPTIONS);
            return res.status(401).json({ success: false, message: "Security Alert: Token reuse detected. All admin sessions revoked." });
        }

        const admin = await Admin.findByPk(tokenRecord.adminId);
        if (!admin || !admin.isApproved || admin.status !== "active") {
            return res.status(403).json({ success: false, message: "Admin account not active or approved." });
        }

        await tokenRecord.update({ revokedAt: new Date() });

        const newAccessToken = generateToken(admin, JWT_ACCESS_EXPIRY);
        const newRefreshTokenVal = await generateOpaqueRefreshToken(null, admin.id, "ADMIN", req.headers["user-agent"]);

        res.cookie("refreshToken", newRefreshTokenVal, COOKIE_OPTIONS);

        logger.info({ traceId: req.id, adminId: admin.id }, "Admin access token refreshed successfully");

        res.json({
            success: true,
            message: "Admin access token refreshed.",
            accessToken: newAccessToken,
            user: {
                id: admin.id,
                fullName: admin.name,
                email: admin.email,
                role: admin.role,
                status: admin.status,
                isApproved: admin.isApproved
            }
        });

    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Admin Refresh Error");
        return res.status(403).json({ success: false, message: "Invalid or expired admin token.", error: error.message });
    }
};

// ============================================================
// 3.2. LOGOUT (Revoke DB token + Clear Cookie)
// ============================================================
exports.logout = async (req, res) => {
    try {
        const rawToken = req.cookies?.refreshToken;
        if (rawToken) {
            const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
            await RefreshToken.update({ revokedAt: new Date() }, { where: { tokenHash } });
        }
        res.clearCookie("refreshToken", COOKIE_OPTIONS);
        res.json({ success: true, message: "Logged out successfully." });
    } catch (error) {
        res.clearCookie("refreshToken", COOKIE_OPTIONS);
        res.json({ success: true, message: "Logged out successfully." });
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
        const refreshTokenVal = await generateOpaqueRefreshToken(null, admin.id, "ADMIN", req.headers["user-agent"]);

        res.cookie("refreshToken", refreshTokenVal, COOKIE_OPTIONS);

        logger.info({ traceId: req.id, adminId: admin.id, email: admin.email }, "Admin account verified and activated");

        res.json({
            success: true,
            message: "✅ Admin account verified and activated.",
            accessToken,
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
        const refreshTokenVal = await generateOpaqueRefreshToken(null, admin.id, "ADMIN", req.headers["user-agent"]);

        res.cookie("refreshToken", refreshTokenVal, COOKIE_OPTIONS);

        logger.info({ traceId: req.id, adminId: admin.id }, "Admin authenticated successfully via 2-step verification");

        res.json({
            success: true,
            message: "Admin authentication successful!",
            accessToken,
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

// ============================================================
// 6. ADMIN DIRECT LOGIN (Email & Password)
// ============================================================
exports.adminLogin = async (req, res) => {
    const { loginId, password } = req.body;

    if (!loginId || !password) {
        return res.status(400).json({ success: false, message: "Login ID and password are required." });
    }

    try {
        const admin = await Admin.findOne({
            where: { email: loginId.toLowerCase().trim() }
        });

        if (!admin) {
            logger.warn({ traceId: req.id, loginId }, "Admin login failed: Admin not found");
            return res.status(401).json({ success: false, message: "Invalid credentials." });
        }

        if (!admin.isApproved || admin.status !== 'active') {
            logger.warn({ traceId: req.id, adminId: admin.id }, "Admin login failed: Account not active or approved");
            return res.status(403).json({ success: false, message: "🚫 Access Denied: Admin account not active or approved." });
        }

        const isMatch = await bcrypt.compare(password, admin.masterPassword);
        if (!isMatch) {
            logger.warn({ traceId: req.id, adminId: admin.id }, "Admin login failed: Invalid password");
            return res.status(401).json({ success: false, message: "Invalid credentials." });
        }

        const accessToken = generateToken(admin, JWT_ACCESS_EXPIRY);
        const refreshTokenVal = await generateOpaqueRefreshToken(null, admin.id, "ADMIN", req.headers["user-agent"]);

        res.cookie("refreshToken", refreshTokenVal, COOKIE_OPTIONS);

        logger.info({ traceId: req.id, adminId: admin.id }, "Admin logged in successfully via direct credentials");

        res.json({
            success: true,
            message: "Admin login successful!",
            accessToken,
            user: {
                id: admin.id,
                fullName: admin.name,
                email: admin.email,
                role: admin.role,
                status: admin.status,
                isApproved: admin.isApproved
            }
        });
    } catch (error) {
        logger.error({ traceId: req.id, error: error.message, stack: error.stack }, "Admin Direct Login Error");
        res.status(500).json({ success: false, message: "Internal server error during login.", error: error.message });
    }
};
