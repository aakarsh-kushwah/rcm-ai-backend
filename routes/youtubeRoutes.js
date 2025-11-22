const { db } = require('../config/db'); 
const axios = require('axios');
const asyncHandler = require('express-async-handler'); 
const { URL } = require('url'); 

// ============================================================
// 🔹 Helper 1: Extract YouTube Video ID (Unchanged)
// ============================================================
const getCleanVideoId = (url) => {
    // ... (Your getCleanVideoId implementation) ...
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
        const description = removeEmojis(response.data.author_name) || '';
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
// ⭐️ YOUTUBE CHANNEL CONTROLLER FUNCTIONS ⭐️
// ============================================================

// POST /api/videos/youtube-channels: Add a new channel or link a video to an existing channel
exports.addChannelOrVideo = asyncHandler(async (req, res) => {
    const { channelName, channelLogoUrl, videoUrl } = req.body;

    if (!channelName || !channelLogoUrl || !videoUrl) {
        return res.status(400).json({ success: false, message: 'Channel name, logo URL, and video URL are required.' });
    }

    const videoDetails = await fetchUrlDetails(videoUrl);

    if (!videoDetails) {
        return res.status(400).json({ success: false, message: 'Failed to fetch video details from the provided URL. Is it a valid YouTube link?' });
    }

    const { publicId, title } = videoDetails;
    const cleanedChannelName = removeEmojis(channelName);
    
    await db.sequelize.transaction(async (t) => {
        
        // A. Check if the video publicId already exists globally
        const existingVideo = await db.YoutubeVideo.findOne({ where: { publicId }, transaction: t });
        if (existingVideo) {
            // 409 Conflict: Resource already exists
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

// GET /api/videos/youtube-channels: Fetch all channels with their linked videos
exports.getAllChannels = asyncHandler(async (req, res) => {
    const channels = await db.YoutubeChannel.findAll({
        include: [{
            model: db.YoutubeVideo,
            as: 'videos',
            attributes: ['id', 'title', 'videoUrl', 'publicId', 'thumbnailUrl', 'createdAt'],
        }],
        order: [
            ['createdAt', 'DESC'],
            [{ model: db.YoutubeVideo, as: 'videos' }, 'createdAt', 'DESC'] 
        ]
    });

    res.status(200).json({ success: true, data: channels });
});

// DELETE /api/videos/youtube-channels/:channelId: Delete an entire channel
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

// DELETE /api/videos/youtube-channels/:channelId/videos/:videoId: Delete a single video from a channel
exports.deleteVideoFromChannel = asyncHandler(async (req, res) => {
    const { channelId, videoId } = req.params;

    const deletedCount = await db.YoutubeVideo.destroy({
        where: { 
            id: videoId,
            channelId: channelId 
        }
    });

    if (deletedCount === 0) {
        return res.status(404).json({ success: false, message: 'Video not found or does not belong to the specified channel.' });
    }

    // Optional: Check if the channel is now empty and delete it if needed
    const videoCount = await db.YoutubeVideo.count({ where: { channelId } });
    if (videoCount === 0) {
        await db.YoutubeChannel.destroy({ where: { id: channelId } });
        return res.status(200).json({ success: true, message: 'Video deleted. Channel deleted as it is now empty.' });
    }

    res.status(200).json({ success: true, message: 'Video deleted successfully from the channel.' });
});


// ⭐️ Exports
// Note: If this is a separate controller file, export only these functions.
exports.addChannelOrVideo = exports.addChannelOrVideo; 
exports.getAllChannels = exports.getAllChannels;
exports.deleteChannel = exports.deleteChannel;
exports.deleteVideoFromChannel = exports.deleteVideoFromChannel;