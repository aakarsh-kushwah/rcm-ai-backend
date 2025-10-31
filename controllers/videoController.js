// backend/controllers/videoController.js
const { db } = require('../config/db'); 

// ============================================================
// 🔹 Helper: Extract YouTube Video ID (11 characters)
// ============================================================
const getCleanVideoId = (url) => {
  const youtubeMatch = url.match(
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/
  );
  if (youtubeMatch && youtubeMatch[1]) {
    return youtubeMatch[1];
  }
  return url; // fallback if not standard YouTube URL
};

// ============================================================
// 🔹 1. Save Video Metadata (POST /api/videos/save-link)
// ============================================================
const saveVideoMetadata = async (req, res) => {
  const { title, description, videoUrl, videoType } = req.body;

  const publicId = getCleanVideoId(videoUrl);
  const Model = videoType === 'leaders' ? db.LeaderVideo : db.ProductVideo;

  if (!title || !videoUrl || publicId.length !== 11) {
    return res.status(400).json({
      success: false,
      message:
        'Invalid or missing Title or YouTube URL. Ensure the URL is correct.',
    });
  }

  try {
    const video = await Model.create({
      title,
      description: description || '',
      videoUrl,
      publicId,
    });

    res.status(201).json({
      success: true,
      message: 'Video link saved successfully!',
      data: video,
    });
  } catch (error) {
    console.error('❌ VIDEO METADATA SAVE FAILED:', error);
    res.status(500).json({
      success: false,
      message: 'An internal server error occurred during metadata save.',
    });
  }
};

// ============================================================
// 🔹 2. Get Videos (GET /api/videos)
// ============================================================
const getVideos = async (Model, req, res) => {
  const { search } = req.query;
  try {
    const videos = await Model.findAll({
      where: search
        ? { title: { [db.Sequelize.Op.like]: `%${search}%` } }
        : undefined,
      order: [['createdAt', 'DESC']],
    });

    res.status(200).json({ success: true, data: videos });
  } catch (error) {
    console.error(`❌ Fetch Videos Failed (${Model.name}):`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch videos due to a server error.',
    });
  }
};

// ============================================================
// 🔹 3. Update Video (PUT /api/videos/:id)
// ============================================================
const updateVideo = async (Model, req, res) => {
  const { id } = req.params;
  const { title, description } = req.body;

  if (!title) {
    return res
      .status(400)
      .json({ success: false, message: 'Title is required for update.' });
  }

  try {
    const [updatedCount, updatedRows] = await Model.update(
      { title, description },
      { where: { id: parseInt(id) }, returning: true }
    );

    if (updatedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: `Video with ID ${id} not found.` });
    }

    res.status(200).json({
      success: true,
      message: 'Video updated successfully!',
      data: updatedRows[0],
    });
  } catch (error) {
    console.error(`❌ Update Failed (${Model.name} ID: ${id}):`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to update video due to a server error.',
    });
  }
};

// ============================================================
// 🔹 4. Delete Video (DELETE /api/videos/:id)
// ============================================================
const deleteVideo = async (Model, req, res) => {
  const { id } = req.params;

  try {
    const deleted = await Model.destroy({ where: { id: parseInt(id) } });

    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: 'Video not found or already deleted.' });
    }

    res.status(200).json({ success: true, message: 'Video deleted successfully.' });
  } catch (error) {
    console.error(`❌ Delete Failed (${Model.name} ID: ${id}):`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete video due to a server error.',
    });
  }
};

// ============================================================
// 🔹 5. Exports (Controller Mappings)
// ============================================================

// ✅ Save new YouTube video metadata
exports.saveVideoMetadata = saveVideoMetadata;

// ✅ Leader Videos
exports.getLeaderVideos = (req, res) => getVideos(db.LeaderVideo, req, res);
exports.updateLeaderVideo = (req, res) => updateVideo(db.LeaderVideo, req, res);
exports.deleteLeaderVideo = (req, res) => deleteVideo(db.LeaderVideo, req, res);

// ✅ Product Videos
exports.getProductVideos = (req, res) => getVideos(db.ProductVideo, req, res);
exports.updateProductVideo = (req, res) => updateVideo(db.ProductVideo, req, res);
exports.deleteProductVideo = (req, res) => deleteVideo(db.ProductVideo, req, res);
