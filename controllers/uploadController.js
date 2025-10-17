const cloudinary = require('cloudinary').v2;

// Cloudinary configuration (ensure your .env file has these)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

// Generates a secure, signed signature for client-side direct upload
const getUploadSignature = (req, res) => {
    // Determine the folder based on the video type requested by the client
    const { videoType } = req.query; 

    if (!videoType || (videoType !== 'leaders' && videoType !== 'products')) {
        return res.status(400).json({ success: false, message: "Invalid video type specified." });
    }

    const timestamp = Math.round(new Date().getTime() / 1000);
    
    // Define public ID and folder path
    const folderPath = `rcm_videos/${videoType}`;
    // Unique Public ID is crucial for direct uploads
    const publicId = `${videoType}-${timestamp}-${Math.random().toString(36).substring(2, 6)}`;

    // Use a unique, signed preset for security in production
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || 'signed_video_upload'; 

    // Parameters for Cloudinary's signature generation
    const params = {
        timestamp: timestamp,
        source: 'uw',
        folder: folderPath,
        public_id: publicId,
        upload_preset: uploadPreset, 
        // Optimization commands for large videos
        resource_type: 'video',
        quality: 'auto:low' 
    };

    // Generate the signature using the private API secret
    const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);

    // Send only necessary data back to the client
    res.json({
        success: true,
        signature,
        timestamp,
        publicId,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload`,
        uploadPreset 
    });
};

module.exports = { getUploadSignature };
