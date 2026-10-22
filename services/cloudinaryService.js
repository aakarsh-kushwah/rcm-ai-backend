/**
 * @file services/cloudinaryService.js
 * @description TITAN V105: Clean-URL Media Engine (Fixed 400 Error & Special Char Bypass)
 *   + uploadNotificationImage: admin banners for push notifications (16:9, throws real errors)
 */

const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const crypto = require('crypto');
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

const generateHash = (data) => crypto.createHash('md5').update(data).digest('hex');

/**
 * ⚡ FAST UPLOAD ENGINE (With Sanitization & Retries)
 */
const fastUpload = async (resource, options) => {
    let attempts = 0;
    const maxRetries = 3;

    while (attempts < maxRetries) {
        try {
            return await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
                    if (error) return reject(error);
                    resolve(result.secure_url);
                });

                if (Buffer.isBuffer(resource)) {
                    streamifier.createReadStream(resource).pipe(uploadStream);
                } else {
                    // Direct URL or Path upload
                    cloudinary.uploader.upload(resource, options)
                        .then(res => resolve(res.secure_url))
                        .catch(err => reject(err));
                }
            });
        } catch (err) {
            attempts++;
            if (attempts >= maxRetries) {
                console.error(`❌ Final Upload Failure after ${maxRetries} attempts:`, err.message);
                return null;
            }
            await new Promise(res => setTimeout(res, Math.pow(2, attempts) * 1000));
        }
    }
};

/**
 * 📸 PRODUCT IMAGE: Safe-Name + High-Res + Auto-Compression
 * Sanitize logic fixes HTTP 400 errors caused by commas and spaces.
 */
const uploadProductImage = async (imageUrl, productName) => {
    if (!imageUrl) return null;

    let resource = imageUrl;
    if (imageUrl.startsWith('data:image')) {
        const base64Data = imageUrl.split(';base64,').pop();
        resource = Buffer.from(base64Data, 'base64');
    }

    // 🛡️ [SANITY CHECK] Clean name for URL safety (Removes commas, dots, spaces)
    const cleanName = productName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_') // Sirf alphanumeric, baki sab underscore
        .replace(/__+/g, '_')      // Double underscores hatao
        .substring(0, 45);          // Max length limit

    // Unique Public ID with hash to avoid overwriting different angles
    const publicId = `prod_${cleanName}_${generateHash(imageUrl).substring(0, 6)}`;

    const options = {
        folder: 'rcm_ai/products',
        public_id: publicId,
        resource_type: 'image',
        overwrite: true,
        // 🔥 TITAN OPTIMIZATION (WebP + Lossy Compression)
        transformation: [
            { width: 1000, crop: "limit" },
            { quality: "auto:best" },
            { fetch_format: "auto" },           // Converts to WebP/AVIF automatically
            { flags: "lossy" }
        ]
    };

    return await fastUpload(resource, options);
};

/**
 * 🎙️ AUDIO ENGINE (For AI Assistant Voice)
 */
const uploadAudioToCloudinary = async (audioSource, voiceLabel) => {
    if (!audioSource) return null;

    const textHash = generateHash(voiceLabel.toString()).substring(0, 10);
    const options = {
        folder: 'rcm_ai/voices',
        public_id: `v_${textHash}`,
        resource_type: 'video',
        format: 'mp3',
        overwrite: false,
        transformation: [
            { audio_codec: "mp3", bit_rate: "44k" }
        ]
    };

    return await fastUpload(audioSource, options);
};

// ============================================================
// 🔔 NOTIFICATION / ANNOUNCEMENT IMAGES (admin panel)
// ============================================================
const NOTIFICATION_FOLDER = process.env.CLOUDINARY_NOTIFICATION_FOLDER || 'rcm_notifications';
const NOTIFICATION_UPLOAD_TIMEOUT_MS = 60 * 1000;

/** True when all three Cloudinary credentials are present. */
const isCloudinaryConfigured = () => {
    const cfg = cloudinary.config();
    return Boolean(cfg.cloud_name && cfg.api_key && cfg.api_secret);
};

/**
 * Real image type from the first bytes of the file (the mimetype sent by the browser can be faked).
 * SVG is intentionally NOT allowed (script injection risk).
 */
const detectImageType = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
};

// banner : 16:9 (1280x720), smart crop, JPG. Best for the big image in a push notification.
// poster : keeps the original ratio, max 1600px.
const NOTIFICATION_PRESETS = {
    banner: {
        transformation: [{ width: 1280, height: 720, crop: 'fill', gravity: 'auto' }, { quality: 'auto:good' }],
        format: 'jpg'
    },
    poster: {
        transformation: [{ width: 1600, height: 1600, crop: 'limit' }, { quality: 'auto:good' }]
    }
};

/**
 * Uploads an image buffer for a notification. Unlike fastUpload, this THROWS on failure,
 * so the API can tell the admin the real reason.
 * Resolves: { url, publicId, width, height, bytes, format }
 */
const uploadNotificationImage = (buffer, { preset = 'banner' } = {}) =>
    new Promise((resolve, reject) => {
        const options = {
            folder: NOTIFICATION_FOLDER,
            public_id: crypto.randomUUID(),
            resource_type: 'image',
            overwrite: false,
            unique_filename: false,
            timeout: NOTIFICATION_UPLOAD_TIMEOUT_MS,
            tags: ['rcm_notification', preset],
            ...(NOTIFICATION_PRESETS[preset] || NOTIFICATION_PRESETS.banner)
        };

        const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) return reject(error);
            if (!result || !result.secure_url) return reject(new Error('Cloudinary returned no URL'));
            return resolve({
                url: result.secure_url,
                publicId: result.public_id,
                width: result.width,
                height: result.height,
                bytes: result.bytes,
                format: result.format
            });
        });
        stream.on('error', reject);
        stream.end(buffer);
    });

module.exports = {
    uploadProductImage,
    uploadAudioToCloudinary,
    uploadNotificationImage,
    detectImageType,
    isCloudinaryConfigured
};