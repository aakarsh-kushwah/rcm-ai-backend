const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const uploadAudioToCloudinary = (buffer, filename) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'video', 
                public_id: `ai_voice_${filename}`,
                folder: 'ai_voice_cache',
                format: 'mp3'
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
            }
        );
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
};

module.exports = { uploadAudioToCloudinary };