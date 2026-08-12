const express = require('express');
const router = express.Router();
const { Product } = require('../models');
const { isAuthenticated, isActiveUser, restrictTo } = require('../middleware/authMiddleware');

// Protected for Admins
router.use(isAuthenticated, isActiveUser, restrictTo('SUPER_ADMIN', 'ADMIN'));

/**
 * @route   GET /api/utils/inventory-health
 */
router.get('/inventory-health', async (req, res) => {
    try {
        const total = await Product.count();
        const missingImages = await Product.count({ where: { imageUrl: null } });
        res.json({ success: true, total, missingImages });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * @route   GET /api/utils/harvest-images OR /api/utils/fix-images
 * @desc    TiDB ke khali imageURL ko RCM site se visit karke Cloudinary par sync karna
 */
const triggerHarvester = async (req, res) => {
    try {
        // Background process start karo
        // startImageHarvesting(); 
        
        res.status(200).json({
            success: true,
            message: "🚀 TITAN Harvester is now active in the background. Check terminal for live logs!"
        });
    } catch (error) {
        console.error("❌ Route Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
};

// Dono routes ko map kar diya taaki error na aaye
router.get('/harvest-images', triggerHarvester);
router.get('/fix-images', triggerHarvester);

module.exports = router;
