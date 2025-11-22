const { db } = require('../config/db'); 
const { Op } = require('sequelize');
const axios = require('axios');
const asyncHandler = require('express-async-handler'); 
const { URL } = require('url'); // URL helper

// ============================================================
// 🔹 Helper 1: Extract YouTube Video ID (Unchanged)
// ============================================================
const getCleanVideoId = (url) => {
    try {
        const videoUrl = new URL(url);
        let publicId = '';
    
        if (videoUrl.hostname === 'youtu.be') {
            publicId = videoUrl.pathname.slice(1);
        } else if (videoUrl.hostname.includes('youtube.com')) {
            if (videoUrl.pathname === '/watch') {
                publicId = videoUrl.searchParams.get('v');
            } else if (videoUrl.pathname.startsWith('/live/')) {
                publicId = videoUrl.pathname.split('/live/')[1];
            } else if (videoUrl.pathname.startsWith('/shorts/')) {
                publicId = videoUrl.pathname.split('/shorts/')[1];
            }
        }
        if (publicId) {
            return publicId.split('?')[0].split('&')[0];
        }
    } catch (error) {
        // Fallback
    }
    const match = url.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([^"&?\/\s]{11})/);
    return match ? match[1] : null;
};

// ============================================================
// 🔹 Helper 2: Emoji Remover (Unchanged)
// ============================================================
const removeEmojis = (str) => {
    if (!str) return '';
    // This regex pattern is generally sufficient for most modern emojis
    return str.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\DFFF]|\uD83D[\uDC00-\DFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '').trim();
};


// ============================================================
// 🔹 Helper 3: URL Scraper (Unchanged)
// ============================================================
const fetchUrlDetails = async (videoUrl) => {
    try {
        const publicId = getCleanVideoId(videoUrl);
        if (!publicId || publicId.length !== 11) {
            throw new Error(`Invalid YouTube ID extracted: ${publicId}`);
        }
        
        // Using YouTube's OEmbed API to get title and thumbnail
        const oEmbedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${publicId}&format=json`;
        
        const response = await axios.get(oEmbedUrl);
        
        const title = removeEmojis(response.data.title);
        const description = removeEmojis(response.data.author_name) || ''; // Author name ko description bana rahe hain
        const thumbnailUrl = response.data.thumbnail_url || `https://i.ytimg.com/vi/${publicId}/mqdefault.jpg`;

        return {
            title,
            description,
            publicId,
            videoUrl: `https://www.youtube.com/watch?v=${publicId}`,
            thumbnailUrl,
        };
    } catch (error) {
        console.warn(`⚠️ Failed to scrape URL: ${videoUrl}. Error: ${error.message}`);
        return null; 
    }
};

// ============================================================
// 🔹 4. Batch Scrape & Import (Unchanged)
// ============================================================
const batchScrapeImport = asyncHandler(async (req, res) => {
    const { urls, videoType, category } = req.body;
    
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ success: false, message: 'No URLs provided.' });
    }

    const Model = videoType === 'leaders' ? db.LeaderVideo : db.ProductVideo;
    if (!Model) {
        return res.status(500).json({ success: false, message: 'Database model not ready.' });
    }

    const videoCategory = (videoType === 'products' && category) ? category.trim() : 'General';

    try {
        const scrapePromises = urls.map(url => fetchUrlDetails(url));
        const results = await Promise.allSettled(scrapePromises);

        const successfulScrapes = results
            .filter(res => res.status === 'fulfilled' && res.value)
            .map(res => res.value);

        if (successfulScrapes.length === 0) {
            return res.status(400).json({ success: false, message: 'Failed to fetch details for all provided URLs. Are they valid YouTube links?' });
        }

        const existingPublicIds = (await Model.findAll({
            attributes: ['publicId'],
            where: {
                publicId: { [Op.in]: successfulScrapes.map(v => v.publicId) }
            }
        })).map(v => v.publicId);

        const newVideosToSave = successfulScrapes
            .filter(video => !existingPublicIds.includes(video.publicId))
            .map(video => ({
                ...video,
                category: videoType === 'products' ? videoCategory : undefined 
            }));


        if (newVideosToSave.length === 0) {
            return res.status(200).json({ 
                success: true, 
                message: `All ${successfulScrapes.length} valid videos are already in your database.`,
                importedCount: 0 
            });
        }

        await Model.bulkCreate(newVideosToSave);

        res.status(201).json({
            success: true,
            message: `Import complete! Added ${newVideosToSave.length} new videos. (Skipped ${existingPublicIds.length} duplicates / ${results.length - successfulScrapes.length} failures).`,
            importedCount: newVideosToSave.length
        });

    } catch (error) {
        console.error('❌ BATCH SCRAPE FAILED:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'An internal server error occurred during batch import.',
        });
    }
});
// ============================================================
// 🔹 5. Get Videos (Internal helper function - Unchanged)
// ============================================================
const getVideos = async (Model, req, res) => {
    if (!Model) {
        return res.status(500).json({ success: false, message: 'Database model not ready.' });
    }
    
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const { category } = req.query;
        
        const options = {
            order: [['createdAt', 'DESC']],
            limit: limit,
            offset: offset,
            where: {}
        };

        if (category && category !== 'All' && Model === db.ProductVideo) {
            options.where.category = category;
        }

        const { count, rows } = await Model.findAndCountAll(options);

        res.status(200).json({
            success: true,
            data: rows,
            pagination: {
                totalItems: count,
                totalPages: Math.ceil(count / limit),
                currentPage: page,
            },
        });
    } catch (error) {
        console.error(`❌ Fetch Videos Failed (${Model.name}):`, error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch videos.',
        });
    }
};

// ============================================================
// 🔹 6. Update Video (Internal helper function - Unchanged)
// ============================================================
const updateVideo = async (Model, req, res) => {
    const { id } = req.params;
    const { title, description, category } = req.body;
    
    if (!Model) {
        return res.status(500).json({ success: false, message: 'Database model not ready.' });
    }

    const cleanedTitle = removeEmojis(title);
    const cleanedDescription = removeEmojis(description);

    if (!cleanedTitle) {
        return res.status(400).json({ success: false, message: 'Title is required.' });
    }
    
    const dataToUpdate = {
        title: cleanedTitle,
        description: cleanedDescription
    };

    if (Model === db.ProductVideo && category) {
        dataToUpdate.category = category.trim() || 'General';
    }

    try {
        const [updatedCount] = await Model.update(
            dataToUpdate,
            { where: { id: parseInt(id) } }
        );

        if (updatedCount === 0) {
            return res.status(404).json({ success: false, message: `Video ID ${id} not found.` });
        }

        res.status(200).json({
            success: true,
            message: 'Video updated successfully!',
        });
    } catch (error) {
        console.error(`❌ Update Failed (${Model.name} ID: ${id}):`, error);
        res.status(500).json({
            success: false,
            message: 'Failed to update video.',
        });
    }
};

// ============================================================
// 🔹 7. Delete Video (Internal helper function - Unchanged)
// ============================================================
const deleteVideo = async (Model, req, res) => {
    const { id } = req.params;
    if (!Model) {
        return res.status(500).json({ success: false, message: 'Database model not ready.' });
    }

    try {
        const deleted = await Model.destroy({ where: { id: parseInt(id) } });
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Video not found.' });
        }
        res.status(200).json({ success: true, message: 'Video deleted.' });
    } catch (error) {
        console.error(`❌ Delete Failed (${Model.name} ID: ${id}):`, error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete video.',
        });
    }
};

// ============================================================
// 🔹 8. Get Product Categories (Unchanged)
// ============================================================
const getProductCategories = asyncHandler(async (req, res) => {
    const categories = await db.ProductVideo.findAll({
        attributes: ['category'], 
        group: ['category'], 
        where: {
            category: { [Op.ne]: null, [Op.ne]: '' } 
        },
        order: [['category', 'ASC']] 
    });

    const categoryList = categories.map(item => item.category);
    
    res.status(200).json({ success: true, data: categoryList });
});


// ============================================================
// ⭐️ YOUTUBE CHANNEL CONTROLLER FUNCTIONS (NEW) ⭐️
// ============================================================

// POST /api/videos/youtube-channels
exports.addChannelOrVideo = asyncHandler(async (req, res) => {
    const { channelName, channelLogoUrl, videoUrl } = req.body;

    if (!channelName || !channelLogoUrl || !videoUrl) {
        return res.status(400).json({ success: false, message: 'Channel name, logo URL, and video URL are required.' });
    }

    // Step 1: Fetch Video Details (Title and publicId)
    const videoDetails = await fetchUrlDetails(videoUrl);

    if (!videoDetails) {
        return res.status(400).json({ success: false, message: 'Failed to fetch video details from the provided URL. Is it a valid YouTube link?' });
    }

    const { publicId, title } = videoDetails;
    const cleanedChannelName = removeEmojis(channelName);
    
    // Use Sequelize Transaction for ACID properties (Production Ready)
    await db.sequelize.transaction(async (t) => {
        
        // A. Check if the video publicId already exists globally
        const existingVideo = await db.YoutubeVideo.findOne({ where: { publicId }, transaction: t });
        if (existingVideo) {
            return res.status(409).json({ success: false, message: `Video with public ID ${publicId} is already linked to a channel.` });
        }

        // B. Find or Create Channel
        let [channel, created] = await db.YoutubeChannel.findOrCreate({
            where: { channelName: cleanedChannelName },
            defaults: { 
                channelName: cleanedChannelName, 
                channelLogoUrl: channelLogoUrl 
            },
            transaction: t,
        });

        // If found, update the logo URL in case the admin changed it
        if (!created && channel.channelLogoUrl !== channelLogoUrl) {
            await channel.update({ channelLogoUrl }, { transaction: t });
        }

        // C. Create and link the new video
        await db.YoutubeVideo.create({
            channelId: channel.id,
            title: removeEmojis(title),
            videoUrl,
            publicId,
            thumbnailUrl: videoDetails.thumbnailUrl,
        }, { transaction: t });

        res.status(201).json({ 
            success: true, 
            message: `Video added successfully to channel: ${channel.channelName}` 
        });
    });
});

// GET /api/videos/youtube-channels
exports.getAllChannels = asyncHandler(async (req, res) => {
    const channels = await db.YoutubeChannel.findAll({
        // Include the linked videos array
        include: [{
            model: db.YoutubeVideo,
            as: 'videos',
            attributes: ['id', 'title', 'videoUrl', 'publicId', 'thumbnailUrl', 'createdAt'],
        }],
        order: [
            ['createdAt', 'DESC'], // Channels ko naye ke hisaab se sort karein
            [{ model: db.YoutubeVideo, as: 'videos' }, 'createdAt', 'DESC'] // Channel ke andar videos ko bhi sort karein
        ]
    });

    res.status(200).json({ success: true, data: channels });
});

// DELETE /api/videos/youtube-channels/:channelId
exports.deleteChannel = asyncHandler(async (req, res) => {
    const { channelId } = req.params;

    const deletedCount = await db.YoutubeChannel.destroy({
        where: { id: channelId }
    });

    if (deletedCount === 0) {
        return res.status(404).json({ success: false, message: 'Channel not found.' });
    }

    // Videos are automatically deleted due to onDelete: 'CASCADE' association
    res.status(200).json({ success: true, message: 'Channel and all linked videos deleted successfully.' });
});

// DELETE /api/videos/youtube-channels/:channelId/videos/:videoId
exports.deleteVideoFromChannel = asyncHandler(async (req, res) => {
    const { channelId, videoId } = req.params;

    const deletedCount = await db.YoutubeVideo.destroy({
        where: { 
            id: videoId,
            channelId: channelId // Ensures the video belongs to the correct channel
        }
    });

    if (deletedCount === 0) {
        return res.status(404).json({ success: false, message: 'Video not found or does not belong to the specified channel.' });
    }

    // Optional: Check if the channel is now empty and delete it if needed (optional cleanup)
    const videoCount = await db.YoutubeVideo.count({ where: { channelId } });
    if (videoCount === 0) {
        await db.YoutubeChannel.destroy({ where: { id: channelId } });
        return res.status(200).json({ success: true, message: 'Video deleted. Channel deleted as it is now empty.' });
    }

    res.status(200).json({ success: true, message: 'Video deleted successfully from the channel.' });
});


// ============================================================
// 🔹 9. Exports (All Wrapped in asyncHandler)
// ============================================================
exports.batchScrapeImport = batchScrapeImport; 
exports.getProductCategories = getProductCategories; 

// Leader Videos
exports.getLeaderVideos = asyncHandler((req, res) => getVideos(db.LeaderVideo, req, res));
exports.updateLeaderVideo = asyncHandler((req, res) => updateVideo(db.LeaderVideo, req, res));
exports.deleteLeaderVideo = asyncHandler((req, res) => deleteVideo(db.LeaderVideo, req, res));

// Product Videos
exports.getProductVideos = asyncHandler((req, res) => getVideos(db.ProductVideo, req, res));
exports.updateProductVideo = asyncHandler((req, res) => updateVideo(db.ProductVideo, req, res));
exports.deleteProductVideo = asyncHandler((req, res) => deleteVideo(db.ProductVideo, req, res));

// ✅ YouTube Channel Exports
exports.addChannelOrVideo = exports.addChannelOrVideo; 
exports.getAllChannels = exports.getAllChannels;
exports.deleteChannel = exports.deleteChannel;
exports.deleteVideoFromChannel = exports.deleteVideoFromChannel;