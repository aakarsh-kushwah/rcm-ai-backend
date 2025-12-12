const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
require('dotenv').config(); 

// --- 🔍 DEBUG: Check if Keys are Loaded ---
// ✅ FIX: Reading the exact names from your .env file
const cloudName = process.env.cloud_name;
const apiKey = process.env.api_key;
const apiSecret = process.env.api_secret;

// Debug log to confirm they are found
if (!cloudName || !apiKey || !apiSecret) {
    console.error("❌ CLOUDINARY ERROR: Keys missing in .env file!");
    console.error(`- cloud_name: ${cloudName ? 'OK' : 'MISSING'}`);
    console.error(`- api_key: ${apiKey ? 'OK' : 'MISSING'}`);
    console.error(`- api_secret: ${apiSecret ? 'OK' : 'MISSING'}`);
} else {
    console.log(`✅ Cloudinary Configured. Cloud: ${cloudName}`);
}

// Configure Cloudinary
cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret
});

/**
 * Uploads a buffer to Cloudinary
 */
const uploadAudioToCloudinary = (buffer, filename) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'video', // 'video' handles audio in Cloudinary
                public_id: `ai_voice_${filename}`,
                folder: 'ai_voice_cache',
                format: 'mp3'
            },
            (error, result) => {
                if (error) {
                    console.error("🔥 Cloudinary Upload Failed:", error);
                    return reject(error);
                }
                resolve(result.secure_url);
            }
        );

        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
};

module.exports = { uploadAudioToCloudinary };