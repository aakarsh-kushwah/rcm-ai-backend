const { PrismaClient } = require('@prisma/client');
// NOTE: Since we are using YouTube links, deleteVideoFromCloudinary is NO LONGER NEEDED 
// and the service should be removed entirely if you are not using Cloudinary for anything else.
// For this file, we will comment out the call to simplify.
// const { deleteVideoFromCloudinary } = require('../services/cloudinaryService'); 
const prisma = new PrismaClient();

// Helper function to extract the 11-character YouTube video ID
const getCleanVideoId = (url) => {
    // This regex extracts the ID from various YouTube formats (watch?v=, youtu.be/, /embed/)
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    if (youtubeMatch && youtubeMatch[1]) {
        return youtubeMatch[1];
    }
    // If it's not a standard YouTube URL, return the original URL as a fallback (though it might not embed)
    return url; 
};

// =======================================================
// 1. Handlers for Saving YouTube Metadata (POST /save-link)
// =======================================================

const saveVideoMetadata = async (req, res) => {
    const { title, description, videoUrl, videoType } = req.body; 
    
    // We store the clean YouTube ID in publicId for reliable embedding on the frontend
    const publicId = getCleanVideoId(videoUrl); 
    const modelName = videoType === 'leaders' ? 'leaderVideo' : 'productVideo';

    if (!title || !videoUrl || publicId.length !== 11) { // Check if a valid YouTube ID was extracted
        return res.status(400).json({ success: false, message: 'Invalid or missing Title or YouTube URL. Ensure the URL is correct.' });
    }

    try {
        const video = await prisma[modelName].create({
            data: {
                title,
                description: description || '',
                videoUrl,
                publicId, // Stores the 11-character YouTube ID
            },
        });
        res.status(201).json({ success: true, message: 'Video link saved successfully!', data: video });
    } catch (error) {
        console.error('--- VIDEO METADATA SAVE FAILED ---', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred during metadata save.' });
    }
};

// =======================================================
// 2. Generic CRUD Functions (GET, PUT, DELETE)
// =======================================================

// A generic function to fetch videos for any model
const getVideos = async (modelName, req, res) => {
    const { search } = req.query;
    try {
        const videos = await prisma[modelName].findMany({
            where: { title: { contains: search || '', mode: 'insensitive' } },
            orderBy: { createdAt: 'desc' },
        });
        // Now returns unoptimized URL, as the frontend will handle embedding
        res.status(200).json({ success: true, data: videos });
    } catch (error) {
        console.error(`[Fetch Videos] Failed to fetch ${modelName}:`, error);
        res.status(500).json({ success: false, message: 'Failed to fetch videos due to a server error.' });
    }
};

const updateVideo = async (modelName, req, res) => {
    const { id } = req.params;
    const { title, description } = req.body;
    
    if (!title) {
         return res.status(400).json({ success: false, message: 'Title is required for update.' });
    }
    
    try {
        const updatedVideo = await prisma[modelName].update({
            where: { id: parseInt(id) },
            data: { title, description },
        });
        res.status(200).json({ success: true, message: 'Video updated successfully!', data: updatedVideo });
    } catch (error) {
        if (error.code === 'P2025') {
            return res.status(404).json({ success: false, message: `Video with ID ${id} not found for update.` });
        }
        console.error(`[Update Video] Failed to update ${modelName} with id ${id}:`, error);
        res.status(500).json({ success: false, message: 'Failed to update video due to a server error.' });
    }
};

const deleteVideo = async (modelName, req, res) => { 
    const { id } = req.params;
    try {
        const video = await prisma[modelName].findUnique({ where: { id: parseInt(id) } });
        if (!video) {
            return res.status(404).json({ success: false, message: 'Video not found.' });
        }
        
        // Removed Cloudinary delete call as we assume only YouTube is used now.
        // If you still use Cloudinary for other files, ensure the corresponding service is defined.
        
        await prisma[modelName].delete({ where: { id: parseInt(id) } });

        res.status(204).json({ success: true, message: 'Video deleted successfully.' });
    } catch (error) {
        if (error.code === 'P2025') {
             return res.status(404).json({ success: false, message: `Video with ID ${id} already deleted.` });
        }
        console.error(`[Delete Video] Failed to delete ${modelName} with id ${id}:`, error);
        res.status(500).json({ success: false, message: 'Failed to delete video due to a server error.' });
    }
};


// 3. Export Mappings (API Endpoints)
exports.saveVideoMetadata = saveVideoMetadata; 

// Leader Video exports
exports.getLeaderVideos = (req, res) => getVideos('leaderVideo', req, res);
exports.updateLeaderVideo = (req, res) => updateVideo('leaderVideo', req, res);
exports.deleteLeaderVideo = (req, res) => deleteVideo('leaderVideo', req, res);

// Product Video exports
exports.getProductVideos = (req, res) => getVideos('productVideo', req, res);
exports.updateProductVideo = (req, res) => updateVideo('productVideo', req, res);
exports.deleteProductVideo = (req, res) => deleteVideo('productVideo', req, res);
