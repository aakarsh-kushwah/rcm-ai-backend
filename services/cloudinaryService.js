/**
 * @file src/services/cloudinaryService.js
 * @description Enterprise-grade Cloudinary uploader with stream safety.
 */
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
require('dotenv').config();

// Configuration Check
if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.error("❌ FATAL: Cloudinary Config Missing");
} else {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

/**
 * Uploads audio buffer to Cloudinary safely.
 * @param {Buffer} buffer - Audio data
 * @param {string} publicId - Unique ID (usually the Text Hash)
 * @returns {Promise<string|null>} Secure URL or null on failure
 */
const uploadAudioToCloudinary = (buffer, publicId) => {
    return new Promise((resolve) => { // Removed 'reject' to prevent server crashes
        // 1. Validation: Prevent empty uploads
        if (!buffer || buffer.length < 100) { // < 100 bytes is likely silence/error
            console.warn("⚠️ [Cloudinary] Upload skipped: Buffer too small/empty.");
            return resolve(null);
        }

        // 2. Upload Stream
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'video', // 'video' handles audio in Cloudinary
                public_id: `rcm_voice_${publicId}`,
                folder: 'rcm_ai_voices',
                format: 'mp3',
                overwrite: false // ⚡ Optimization: Don't overwrite if hash exists
            },
            (error, result) => {
                if (error) {
                    console.error(`🔥 [Cloudinary] Upload Error: ${error.message}`);
                    return resolve(null); // Fail Safe
                }
                resolve(result.secure_url);
            }
        );

        // 3. Pipe Execution
        try {
            streamifier.createReadStream(buffer).pipe(uploadStream);
        } catch (streamError) {
            console.error(`🔥 [Cloudinary] Stream Pipe Error: ${streamError.message}`);
            resolve(null);
        }
    });
};

module.exports = { uploadAudioToCloudinary };