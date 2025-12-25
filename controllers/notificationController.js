const { db } = require("../config/db");
const admin = require("../config/firebase");
const { Op } = require('sequelize');

// 1. User Endpoint: Save Device Token
const saveFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.id;

    if (!token) return res.status(400).json({ success: false, message: "Token required" });

    // Update the user's token in the database
    await db.User.update({ fcmToken: token }, { where: { id: userId } });

    res.status(200).json({ success: true, message: "FCM Token registered successfully" });
  } catch (error) {
    console.error("Save Token Error:", error);
    res.status(500).json({ success: false, message: "Error saving token" });
  }
};

// 2. Admin Endpoint: Send Blast Notification
const sendAnnouncement = async (req, res) => {
  try {
    const { title, body, imageUrl } = req.body;

    if (!title || !body) {
      return res.status(400).json({ success: false, message: "Title and Body are required" });
    }

    // Fetch all users with a valid token
    const users = await db.User.findAll({
      where: {
        fcmToken: { [Op.ne]: null }
      },
      attributes: ['fcmToken']
    });

    // Extract tokens and remove duplicates/empties
    const tokens = [...new Set(users.map(u => u.fcmToken).filter(t => t))];

    if (tokens.length === 0) {
      return res.status(404).json({ success: false, message: "No registered devices found." });
    }

    // ✅ FIX: Use DATA-ONLY payload to prevent double notifications
    const message = {
      // ❌ DELETED: notification: { title, body }, 
      
      data: {
        title: title,
        body: body,
        icon: '/rcmai_logo.png', // Path to your logo
        url: '/',                // URL to open on click
        imageUrl: imageUrl || ""
      },
      tokens: tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log(`✅ Notification Sent! Success: ${response.successCount}, Failed: ${response.failureCount}`);

    // Clean up invalid tokens
    if (response.failureCount > 0) {
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                // Optional: db.User.update({ fcmToken: null }, { where: { fcmToken: tokens[idx] } });
                console.log(`Invalid token found: ${tokens[idx]}`);
            }
        });
    }

    res.status(200).json({
      success: true,
      message: `Notification sent to ${response.successCount} devices.`,
      failedCount: response.failureCount
    });

  } catch (error) {
    console.error("Notification Error:", error);
    res.status(500).json({ success: false, message: "Failed to send notification" });
  }
};

module.exports = { saveFcmToken, sendAnnouncement };