// controllers/userController.js

// ✅ Sahi import
const { db } = require('../config/db');

// ============================================================
// 🔹 GET MY PROFILE (User Only)
// Route: GET /api/users/me
// ============================================================
const getMyProfile = async (req, res) => {
  try {
    if (!db.User) {
        return res.status(500).json({ success: false, message: 'Server error: User model is not available.' });
    }

    // req.user 'isAuthenticated' मिडलवेयर से आता है
    const userId = req.user.id; 

    const user = await db.User.findByPk(userId, {
      // ⭐️ UPDATE: 'profilePic' ko yahan add kiya gaya hai
      // Taaki jab user login kare toh photo bhi load ho
      attributes: [
            'id', 
            'fullName', 
            'email', 
            'rcmId', 
            'status', 
            'role', 
            'autoPayStatus', 
            'nextBillingDate',
            'profilePic' // ✅ YEH ZAROORI HAI
        ]
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

// ============================================================
// ⭐️ NAYA FUNCTION (Aapka 404 error fix karne ke liye)
// 🔹 UPDATE MY PROFILE PIC (User Only)
// Route: PATCH /api/users/update-profile-pic
// ============================================================
const updateMyProfilePic = async (req, res) => {
    try {
        const { profilePic } = req.body; // Nayi Base64 image string
        const userId = req.user.id; // 'isAuthenticated' middleware se

        if (!profilePic) {
            return res.status(400).json({ success: false, message: 'No picture provided' });
        }

        // Sequelize ka istemaal karke 'profilePic' update karein
        const [updatedCount] = await db.User.update(
            { profilePic: profilePic }, // Naya data
            { where: { id: userId } }   // Kise update karna hai
        );

        if (updatedCount === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Naya (updated) user data database se fetch karein
        const updatedUser = await db.User.findByPk(userId, {
            attributes: { exclude: ['password'] } // Password waapas na bhejें
        });

        // Naya data frontend ko bhejें (taaki localStorage update ho sake)
        res.json({ 
            success: true, 
            message: 'Profile picture updated successfully',
            userData: updatedUser 
        });

    } catch (error) {
        console.error('❌ Error updating profile pic:', error);
        res.status(500).json({ success: false, message: 'Server error while updating picture' });
    }
};


// ✅ Dono functions ko export karein
module.exports = {
  getMyProfile,
  updateMyProfilePic // ⭐️ Ise add karein
};