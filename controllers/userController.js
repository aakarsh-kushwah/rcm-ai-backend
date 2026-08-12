// ✅ सही तरीका: मॉडल को 'db.js' से इम्पोर्ट करें
const { User } = require('../models'); // Imported User model directly from models hub

// ============================================================
// 🔹 GET MY PROFILE (User Only)
// Route: GET /api/users/me
// ============================================================
const getMyProfile = async (req, res) => {
  try {
    // 🌟 जांचें कि User मॉडल लोड हुआ है या नहीं
    if (!User) {
        return res.status(500).json({ success: false, message: 'Server error: User model is not available.' });
    }

    // req.user 'isAuthenticated' मिडलवेयर से आता है
    const userId = req.user.id; 

    const user = await User.findByPk(userId, {
      // पासवर्ड को कभी भी वापस न भेजें
      attributes: ['id', 'fullName', 'email', 'rcmId', 'status', 'role', 'autoPayStatus', 'nextBillingDate']
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({ success: true, data: user });

  } catch (error) {
    console.error("❌ Get Profile Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch profile." });
  }
};

// 💡 इसे सही से एक्सपोर्ट करें
module.exports = {
  getMyProfile
};