const cloudinary = require('cloudinary').v2;
const DatauriParser = require('datauri/parser');
const path = require('path');

// Configure Cloudinary with credentials from your .env file
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const parser = new DatauriParser();

/**
 * Uploads a video file to Cloudinary.
 * @param {object} file - The file object from Multer.
 * @returns {Promise<object>} - The upload result from Cloudinary.
 */
const uploadVideoToCloudinary = (file) => {
    // Get the file extension (e.g., '.mp4')
    const fileExtension = path.extname(file.originalname).toString();
    
    // Convert the file buffer to a Data URI string
    const fileContent = parser.format(fileExtension, file.buffer).content;

    // Return a promise for the upload operation
    return cloudinary.uploader.upload(fileContent, {
        resource_type: "video",
        folder: "rcm_videos", // Organize all videos in a specific folder
    });
};

/**
 * Deletes a video file from Cloudinary.
 * @param {string} publicId - The public_id of the video to delete.
 * @returns {Promise<object>} - The deletion result from Cloudinary.
 */
const deleteVideoFromCloudinary = (publicId) => {
    return cloudinary.uploader.destroy(publicId, {
        resource_type: "video",
    });
};

module.exports = {
    uploadVideoToCloudinary,
    deleteVideoFromCloudinary,
};