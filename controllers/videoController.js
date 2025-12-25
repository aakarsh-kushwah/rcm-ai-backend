const { db } = require('../config/db'); 
const { Op } = require('sequelize');
const axios = require('axios');
const asyncHandler = require('express-async-handler'); // Error handling ke liye

// ============================================================
// 🔹 Helper 1: Extract YouTube Video ID
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
// 🔹 Helper 2: Emoji Remover
// ============================================================
const removeEmojis = (str) => {
  if (!str) return '';
  return str.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\DFFF]|\uD83D[\uDC00-\DFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '').trim();
};


// ============================================================
// 🔹 3. URL Scraper
// ============================================================
const fetchUrlDetails = async (videoUrl) => {
  try {
    const publicId = getCleanVideoId(videoUrl);
    if (!publicId || publicId.length !== 11) {
      throw new Error(`Invalid YouTube ID extracted: ${publicId}`);
    }
    
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
// 🔹 4. Batch Scrape & Import (Wrapped in asyncHandler)
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

    // try/catch block yahan rakhein kyunki Promise.allSettled errors throw nahi karta
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
        // asyncHandler is error ko pakad lega, lekin custom response behtar hai
        res.status(500).json({
            success: false,
            message: error.message || 'An internal server error occurred during batch import.',
        });
    }
});


// ============================================================
// 🔹 5. Get Videos (Internal helper function)
// ============================================================
const getVideos = async (Model, req, res) => {
  if (!Model) {
    return res.status(500).json({ success: false, message: 'Database model not ready.' });
  }
  
  // Is internal function mein try/catch zaroori hai kyunki yeh seedha asyncHandler se wrap nahi hai
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
// 🔹 6. Update Video (Internal helper function)
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
// 🔹 7. Delete Video (Internal helper function)
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
// 🔹 8. Get Product Categories (Optimized & Wrapped)
// ============================================================
const getProductCategories = asyncHandler(async (req, res) => {
  
  // Performance: 'DISTINCT' ki jagah 'GROUP BY' ka istemaal karein
  const categories = await db.ProductVideo.findAll({
       attributes: ['category'], // Sirf category column chahiye
       group: ['category'], // Isse distinct values milengi
       where: {
           category: { [Op.ne]: null, [Op.ne]: '' } // Empty ya null na ho
       },
       order: [['category', 'ASC']] // Alphabetical sort
  });

  const categoryList = categories.map(item => item.category);
  
  res.status(200).json({ success: true, data: categoryList });
  
  // try/catch ki zaroorat nahi, asyncHandler errors ko pakad lega
});


// ============================================================
// 🔹 9. Exports (Sabhi ko asyncHandler se wrap kiya gaya)
// ============================================================
exports.batchScrapeImport = batchScrapeImport; // Yeh pehle se hi wrapped hai
exports.getProductCategories = getProductCategories; // Yeh bhi wrapped hai

// Leader Videos
exports.getLeaderVideos = asyncHandler((req, res) => getVideos(db.LeaderVideo, req, res));
exports.updateLeaderVideo = asyncHandler((req, res) => updateVideo(db.LeaderVideo, req, res));
exports.deleteLeaderVideo = asyncHandler((req, res) => deleteVideo(db.LeaderVideo, req, res));

// Product Videos
exports.getProductVideos = asyncHandler((req, res) => getVideos(db.ProductVideo, req, res));
exports.updateProductVideo = asyncHandler((req, res) => updateVideo(db.ProductVideo, req, res));
exports.deleteProductVideo = asyncHandler((req, res) => deleteVideo(db.ProductVideo, req, res));