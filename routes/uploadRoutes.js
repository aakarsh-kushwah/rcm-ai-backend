/**
 * @file routes/uploadRoutes.js
 * @description POST /api/upload/image  (admin only)
 *   multipart/form-data, field name: "image"  (field "file" is also accepted)
 *   Optional query: ?type=banner (default, 16:9) | ?type=poster
 *   Response: { success, url, publicId, width, height, bytes, format }
 *
 *   Uses its own image-only Multer config. middleware/uploadMiddleware.js is video-only and is NOT touched.
 */

const express = require("express");
const multer = require("multer");
const asyncHandler = require("express-async-handler");

const { isAuthenticated, isActiveUser, restrictTo } = require("../middleware/authMiddleware");
const { createLimiter, userKeyGenerator } = require("../middleware/rateLimiter");
const cloudinaryService = require("../services/cloudinaryService");

const router = express.Router();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 10, parts: 20 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
        const err = new Error("Only JPG, PNG, WEBP or GIF images are allowed");
        err.status = 400;
        return cb(err, false);
    },
});

const receiveImage = upload.fields([
    { name: "image", maxCount: 1 },
    { name: "file", maxCount: 1 },
]);

const uploadLimiter = createLimiter({
    windowMs: 60 * 1000,
    limit: 20,
    prefix: "rl:upload:",
    keyGenerator: userKeyGenerator,
    message: "Too many uploads. Please wait a minute.",
});

const handleUpload = async (req, res) => {
    const file =
        (req.files && ((req.files.image && req.files.image[0]) || (req.files.file && req.files.file[0]))) || null;

    if (!file) {
        return res.status(400).json({
            success: false,
            message: 'No image received. Send multipart/form-data with the file in field "image".',
        });
    }

    if (!cloudinaryService.detectImageType(file.buffer)) {
        return res.status(400).json({ success: false, message: "File is not a valid JPG, PNG, WEBP or GIF image" });
    }

    if (!cloudinaryService.isCloudinaryConfigured()) {
        console.error("🔥 [UPLOAD] Cloudinary is not configured (check CLOUDINARY_* env variables)");
        return res.status(503).json({ success: false, message: "Image storage is not configured on the server" });
    }

    const preset = req.query.type === "poster" ? "poster" : "banner";

    try {
        const result = await cloudinaryService.uploadNotificationImage(file.buffer, { preset });

        res.set("Cache-Control", "no-store");
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        const reason = (err && err.message) || "Unknown error";
        console.error(`🔥 [UPLOAD] Cloudinary upload failed (${err && err.http_code ? err.http_code : "n/a"}): ${reason}`);
        // Admin-only endpoint, so the real reason is safe and useful to show.
        return res.status(502).json({ success: false, message: "Image upload to storage failed", detail: reason });
    }
};

router.post(
    "/image",
    isAuthenticated,
    isActiveUser,
    restrictTo("SUPER_ADMIN", "ADMIN"),
    uploadLimiter,
    receiveImage, // Multer errors go to the global error handler in server.js (413 / 400)
    asyncHandler(handleUpload)
);

module.exports = router;