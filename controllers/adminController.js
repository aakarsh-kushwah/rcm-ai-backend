const { db } = require('../config/db');
const { Op } = require('sequelize'); // सर्चिंग के लिए

// Safe way to get User model after db initialization
// हम मान रहे हैं कि db.js 'initialize' को पहले ही हैंडल कर रहा है
const User = db.User;
const ChatMessage = db.ChatMessage;

const userSelectFields = ['id', 'fullName', 'rcmId', 'email', 'phone', 'role', 'status', 'autoPayStatus', 'createdAt'];

// =======================================================
// 1️⃣ GET ALL USERS (Admin Only)
// Route: GET /api/admin/users
// =======================================================
const getRegularUsers = async (req, res) => {
  try {
    if (!User) throw new Error('User model not ready.');
    const users = await User.findAll({
      where: { 
        role: { [Op.ne]: 'ADMIN' } // 'ADMIN' के अलावा सब
      }, 
      attributes: userSelectFields,
      order: [['createdAt', 'DESC']],
    });
    res.status(200).json({ success: true, data: users });
  } catch (error) {
    console.error('❌ Error fetching regular users:', error);
    res.status(500).json({ success: false, message: 'Internal server error.', error: error.message });
  }
};

// =======================================================
// 2️⃣ GET ALL ADMINS (Admin Only)
// Route: GET /api/admin/admins
// =======================================================
const getAllAdmins = async (req, res) => {
  try {
    if (!User) throw new Error('User model not ready.');
    const admins = await User.findAll({
      where: { role: 'ADMIN' },
      attributes: userSelectFields,
      order: [['createdAt', 'DESC']],
    });
    res.status(200).json({ success: true, data: admins });
  } catch (error) {
    console.error('❌ Error fetching admins:', error);
    res.status(500).json({ success: false, message: 'Internal server error.', error: error.message });
  }
};

// ============================================================
// 3️⃣ DELETE USER (Admin Only)
// Route: DELETE /api/admin/users/:userId
// ============================================================
const deleteUser = async (req, res) => {
  const { userId } = req.params;

  if (!User || !ChatMessage) throw new Error('Models not ready.');

  // एडमिन को खुद को डिलीट करने से रोकें
  if (req.user && req.user.id === parseInt(userId, 10)) {
    return res.status(403).json({
      success: false,
      message: "You cannot delete your own admin account.",
    });
  }

  try {
    // 1️⃣ यूज़र के चैट मैसेज पहले डिलीट करें
    await ChatMessage.destroy({
      where: { userId: parseInt(userId, 10) },
    });

    // 2️⃣ अब यूज़र को डिलीट करें
    const deletedUser = await User.destroy({
      where: { id: parseInt(userId, 10) },
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
// 4️⃣ UPDATE USER DATA (Admin Only)
// Route: PATCH /api/admin/users/:userId
// ============================================================
const updateUserData = async (req, res) => {
  const { userId } = req.params;
  // एडमिन द्वारा अपडेट किए जा सकने वाले फ़ील्ड्स
  const { fullName, email, rcmId, status, role, autoPayStatus, nextBillingDate } = req.body;
  if (!User) throw new Error('User model not ready.');

  // एक 'update' ऑब्जेक्ट बनाएँ ताकि सिर्फ़ वही फ़ील्ड्स अपडेट हों जो भेजी गई हैं
  const fieldsToUpdate = {};
  if (fullName !== undefined) fieldsToUpdate.fullName = fullName;
  if (email !== undefined) fieldsToUpdate.email = email;
  if (rcmId !== undefined) fieldsToUpdate.rcmId = rcmId;
  if (status !== undefined) fieldsToUpdate.status = status;
  if (role !== undefined) fieldsToUpdate.role = role;
  if (autoPayStatus !== undefined) fieldsToUpdate.autoPayStatus = autoPayStatus;
  
  // nextBillingDate को null पर सेट करने की अनुमति दें
  if (nextBillingDate === null) {
    fieldsToUpdate.nextBillingDate = null;
  } else if (nextBillingDate) {
    fieldsToUpdate.nextBillingDate = new Date(nextBillingDate);
  }

  try {
    const [updatedRowsCount] = await User.update(
      fieldsToUpdate,
      {
        where: { id: parseInt(userId, 10) },
      }
    );

    if (updatedRowsCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "User not found or no changes made." });
    }
    
    const updatedUser = await User.findByPk(userId, {
        attributes: { exclude: ['password'] } // पासवर्ड को छोड़कर
    });

    res.status(200).json({
      success: true,
      message: "User data updated successfully.",
      data: updatedUser,
    });
  } catch (error) {
    console.error("❌ User update failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update user data." });
  }
};


// 💡 सभी 4 फ़ंक्शंस को एक्सपोर्ट करें
module.exports = { 
  getRegularUsers,
  getAllAdmins,
  deleteUser, 
  updateUserData
};

