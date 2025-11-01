// backend/controllers/adminController.js
const User = require('../models/user.model'); // ✅ Directly import model

// Define which fields we want to include in the response
const userSelectFields = ['id', 'fullName', 'rcmId', 'email', 'phone', 'role', 'createdAt'];

// =======================================================
// 1️⃣ Fetch only regular users (role = 'USER')
// =======================================================
const getRegularUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { role: 'USER' },
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
// 2️⃣ Fetch only admins (role = 'ADMIN')
// =======================================================
const getAllAdmins = async (req, res) => {
  try {
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

// =======================================================
// 3️⃣ Exports
// =======================================================
module.exports = {
  getRegularUsers,
  getAllAdmins,
};
