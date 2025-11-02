// backend/controllers/adminController.js
const dbModule = require('../config/db');

// Safe way to get User model after db initialization
let User;
(async () => {
  await dbModule.initialize(); // Ensure DB connection and model sync
  User = dbModule.db.User;
  console.log('✅ User model loaded successfully in adminController');
})();

const userSelectFields = ['id', 'fullName', 'rcmId', 'email', 'phone', 'role', 'createdAt'];

// =======================================================
// 1️⃣ Fetch only regular users
// =======================================================
const getRegularUsers = async (req, res) => {
  try {
    if (!User) throw new Error('User model not initialized yet.');
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
// 2️⃣ Fetch only admins
// =======================================================
const getAllAdmins = async (req, res) => {
  try {
    if (!User) throw new Error('User model not initialized yet.');
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

module.exports = {
  getRegularUsers,
  getAllAdmins,
};
