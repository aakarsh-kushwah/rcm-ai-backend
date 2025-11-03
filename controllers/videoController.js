// backend/controllers/videoController.js
const { db } = require('../config/db'); 
const { Op } = require('sequelize');
const axios = require('axios'); // ✅ HTML लाने के लिए
const cheerio = require('cheerio'); // ✅ HTML पढ़ने के लिए

// ============================================================
// 🔹 Helper: Extract YouTube Video ID
// ============================================================
const getCleanVideoId = (url) => {
  try {
    const videoUrl = new URL(url);
    if (videoUrl.hostname === 'youtu.be') {
      return videoUrl.pathname.slice(1); // 'youtu.be/' के बाद
    }
    if (videoUrl.hostname.includes('youtube.com') && videoUrl.pathname === '/watch') {
      return videoUrl.searchParams.get('v'); // 'v=' के बाद
    }
  } catch (error) {
    // अगर URL गलत है
  }
  
  // पुरानी regex (रेगेक्स) fallback
  const match = url.match(/(?:v=|\/)([^"&?\/\s]{11})/);
  return match ? match[1] : null; // null रिटर्न करें अगर ID न मिले
};

// ============================================================
// 🔹 1. Naya: URL Scraper (100% Free)
// यह टाइटल और विवरण को सीधे YouTube पेज से लाता है
// ============================================================
const fetchUrlDetails = async (videoUrl) => {
  try {
    const publicId = getCleanVideoId(videoUrl);
    if (!publicId || publicId.length !== 11) {
      throw new Error('Invalid YouTube URL');
    }
    
    // (YouTube oEmbed API का इस्तेमाल करें - यह फ्री है और API Key नहीं माँगता)
    const oEmbedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${publicId}&format=json`;
    
    const response = await axios.get(oEmbedUrl);
    
    const title = response.data.title;
    // oEmbed विवरण नहीं देता, इसलिए हम उसे खाली छोड़ देंगे (या टाइटल का इस्तेमाल करेंगे)
    const description = response.data.author_name || ''; 
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
    return null; // जो URL फेल हो, उसे छोड़ दें
  }
};


// ============================================================
// 🔹 2. Naya: Batch Scrape & Import (Multiple URLs)
// ============================================================
const batchScrapeImport = async (req, res) => {
    const { urls, videoType } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ success: false, message: 'No URLs provided.' });
    }

    const Model = videoType === 'leaders' ? db.LeaderVideo : db.ProductVideo;
    if (!Model) {
        return res.status(500).json({ success: false, message: 'Database model not ready.' });
    }

    try {
        // 1. Scalable: सभी URLs को एक साथ (parallel) स्क्रैप करें
        const scrapePromises = urls.map(url => fetchUrlDetails(url));
        const results = await Promise.allSettled(scrapePromises);

        // 2. जो स्क्रैप सफल हुए, उन्हें फ़िल्टर करें
        const successfulScrapes = results
            .filter(res => res.status === 'fulfilled' && res.value)
            .map(res => res.value);

        if (successfulScrapes.length === 0) {
             return res.status(400).json({ success: false, message: 'Failed to fetch details for all provided URLs. Are they valid YouTube links?' });
        }

        // 3. Safe: डुप्लीकेट चेक करें
        const existingPublicIds = (await Model.findAll({
            attributes: ['publicId'],
            where: {
                publicId: { [Op.in]: successfulScrapes.map(v => v.publicId) }
            }
        })).map(v => v.publicId);

        // 4. सिर्फ़ नए वीडियो को फ़िल्टर करें
        const newVideosToSave = successfulScrapes.filter(video => !existingPublicIds.includes(video.publicId));

        if (newVideosToSave.length === 0) {
            return res.status(200).json({ 
                success: true, 
                message: `All ${successfulScrapes.length} valid videos are already in your database.`,
                importedCount: 0 
            });
        }

        // 5. Zero Load: एक ही कमांड में सभी नए वीडियो सेव करें
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
};


// ============================================================
// 🔹 3. Get Videos (Production Ready - Pagination)
// ============================================================
const getVideos = async (Model, req, res) => {
  if (!Model) {
    return res.status(500).json({ success: false, message: 'Database model not ready.' });
  }
  try {
    // Page 1, Limit 20 (default)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { count, rows } = await Model.findAndCountAll({
      order: [['createdAt', 'DESC']],
      limit: limit,
      offset: offset,
    });

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
// 🔹 4. Update Video
// ============================================================
const updateVideo = async (Model, req, res) => {
  const { id } = req.params;
  const { title, description } = req.body;
  if (!Model) {
    return res.status(500).json({ success: false, message: 'Database model not ready.' });
  }

  if (!title) {
    return res.status(400).json({ success: false, message: 'Title is required.' });
  }

  try {
    const [updatedCount] = await Model.update(
      { title, description },
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
// 🔹 5. Delete Video
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
// 🔹 6. Exports
// ============================================================
exports.batchScrapeImport = batchScrapeImport; // ✅ Naya export

// Leader Videos
exports.getLeaderVideos = (req, res) => getVideos(db.LeaderVideo, req, res);
exports.updateLeaderVideo = (req, res) => updateVideo(db.LeaderVideo, req, res);
exports.deleteLeaderVideo = (req, res) => deleteVideo(db.LeaderVideo, req, res);

// Product Videos
exports.getProductVideos = (req, res) => getVideos(db.ProductVideo, req, res);
exports.updateProductVideo = (req, res) => updateVideo(db.ProductVideo, req, res);
exports.deleteProductVideo = (req, res) => deleteVideo(db.ProductVideo, req, res);