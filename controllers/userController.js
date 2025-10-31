// backend/controllers/adminUserController.js
const { db } = require('../config/db');

// ============================================================
// 🔹 DELETE USER (Admin Only)
// Route: DELETE /api/admin/users/:userId
// ============================================================
const deleteUser = async (req, res) => {
  const { userId } = req.params;

  // Prevent admin from deleting themselves
  if (req.user && req.user.id === parseInt(userId)) {
    return res.status(403).json({
      success: false,
      message: "You cannot delete your own admin account.",
    });
  }

  try {
    // 1️⃣ Delete all user's chat messages first
    await db.ChatMessage.destroy({
      where: { userId: parseInt(userId) },
    });

    // 2️⃣ Delete the user
    const deletedUser = await db.User.destroy({
      where: { id: parseInt(userId) },
    });

    if (!deletedUser) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    res.status(200).json({
      success: true,
      message: "User and all associated data deleted successfully.",
    });
  } catch (error) {
    console.error("❌ User deletion failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete user due to a server error.",
    });
  }
};

// ============================================================
// 🔹 UPDATE USER DATA (Admin Only)
// Route: PATCH /api/admin/users/:userId
// ============================================================
const updateUserData = async (req, res) => {
  const { userId } = req.params;
  const { autoPayStatus, nextBillingDate } = req.body;

  try {
    const [updatedRowsCount, updatedUsers] = await db.User.update(
      {
        autoPayStatus,
        nextBillingDate: nextBillingDate ? new Date(nextBillingDate) : null,
      },
      {
        where: { id: parseInt(userId) },
        returning: true,
      }
    );

    if (updatedRowsCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found for update." });
    }

    res.status(200).json({
      success: true,
      message: "User data updated successfully.",
      data: updatedUsers[0],
    });
  } catch (error) {
    console.error("❌ User update failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update user data." });
  }
};

module.exports = { deleteUser, updateUserData };
