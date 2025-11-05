// backend/controllers/adminController.js
const { db } = require('../config/db');
const { Op } = require('sequelize'); // Sequelize operators के लिए

// ✅ क्रिटिकल फिक्स: मॉडल्स को सीधे 'db' ऑब्जेक्ट से लें
// (initialize() को यहाँ से हटा दिया गया है)
const { User, ChatMessage, sequelize } = db; 

// फ़ील्ड्स जिन्हें Admin Users और Regular Users दोनों के लिए चुना जाएगा
const userSelectFields = [
    'id', 
    'fullName', 
    'rcmId', 
    'email', 
    'phone', 
    'role', 
    'status', 
    'autoPayStatus', 
    'createdAt'
];

// =======================================================
// 1️⃣ GET ALL REGULAR USERS (Admin Only)
// Route: GET /api/admin/users
// =======================================================
const getRegularUsers = async (req, res) => {
    try {
        // ✅ फिक्स: पक्का करें कि 'User' मॉडल लोड हो चुका है
        if (!User) {
            return res.status(500).json({ success: false, message: 'Server error: User model is not available.' });
        }

        const users = await User.findAll({
            where: { 
                role: { [Op.ne]: 'ADMIN' } // 'ADMIN' रोल के अलावा सभी
            }, 
            attributes: userSelectFields,
            order: [['createdAt', 'DESC']],
        });
        res.status(200).json({ success: true, data: users });
    } catch (error) {
        console.error('❌ Error fetching regular users:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch users.', error: error.message });
    }
};

// =======================================================
// 2️⃣ GET ALL ADMINS (Admin Only)
// Route: GET /api/admin/admins
// =======================================================
const getAllAdmins = async (req, res) => {
    try {
        if (!User) {
            return res.status(500).json({ success: false, message: 'Server error: User model is not available.' });
        }

        const admins = await User.findAll({
            where: { role: 'ADMIN' },
            attributes: userSelectFields,
            order: [['createdAt', 'DESC']],
        });
        res.status(200).json({ success: true, data: admins });
    } catch (error) {
        console.error('❌ Error fetching admins:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch admins.', error: error.message });
    }
};

// ============================================================
// 3️⃣ DELETE USER (Admin Only) - 🛡️ Transaction के साथ सुरक्षित
// Route: DELETE /api/admin/users/:userId
// ============================================================
const deleteUser = async (req, res) => {
    const { userId } = req.params;

    if (!User || !ChatMessage || !sequelize) {
        return res.status(500).json({ success: false, message: 'Server models not fully ready for operation.' });
    }

    // Admin को खुद को डिलीट करने से रोकें
    if (req.user && req.user.id === parseInt(userId, 10)) {
        return res.status(403).json({
            success: false,
            message: "You cannot delete your own admin account.",
        });
    }

    // ⭐ ट्रांजैक्शन शुरू करें
    const transaction = await sequelize.transaction();

    try {
        // 1️⃣ यूज़र के ChatMessage को डिलीट करें (Transaction के अंदर)
        await ChatMessage.destroy({
            where: { userId: parseInt(userId, 10) },
            transaction,
        });

        // 2️⃣ अब यूज़र को डिलीट करें (Transaction के अंदर)
        const deletedUserCount = await User.destroy({
            where: { id: parseInt(userId, 10) },
            transaction,
        });

        await transaction.commit(); // ✅ सब ठीक रहा, बदलावों को सेव करें

        if (deletedUserCount === 0) {
            return res.status(404).json({ success: false, message: "User not found or already deleted." });
        }

        res.status(200).json({
            success: true,
            message: "User and all associated data deleted successfully.",
        });
    } catch (error) {
        await transaction.rollback(); // ❌ त्रुटि हुई, सभी बदलावों को वापस लें
        console.error("❌ User deletion failed and rolled back:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete user due to a server error. Operation was rolled back.",
        });
    }
};

// ============================================================
// 4️⃣ UPDATE USER DATA (Admin Only)
// Route: PATCH /api/admin/users/:userId
// ============================================================
const updateUserData = async (req, res) => {
    const { userId } = req.params;
    
    // Admin द्वारा अपडेट किए जा सकने वाले फ़ील्ड्स
    const { fullName, email, rcmId, status, role, autoPayStatus, nextBillingDate } = req.body;
    
    if (!User) {
        return res.status(500).json({ success: false, message: 'User model is not initialized.' });
    }

    // Dynamic 'fieldsToUpdate' ऑब्जेक्ट बनाएँ
    const fieldsToUpdate = {};
    if (fullName !== undefined) fieldsToUpdate.fullName = fullName;
    if (email !== undefined) fieldsToUpdate.email = email;
    if (rcmId !== undefined) fieldsToUpdate.rcmId = rcmId;
    if (status !== undefined) fieldsToUpdate.status = status;
    if (role !== undefined) fieldsToUpdate.role = role;
    if (autoPayStatus !== undefined) fieldsToUpdate.autoPayStatus = autoPayStatus;
    
    // nextBillingDate हैंडलिंग
    if (nextBillingDate === null) {
        fieldsToUpdate.nextBillingDate = null; // null पर सेट करने की अनुमति दें
    } else if (nextBillingDate) {
        fieldsToUpdate.nextBillingDate = new Date(nextBillingDate);
    }
    
    // अगर कोई फ़ील्ड अपडेट करने के लिए नहीं है
    if (Object.keys(fieldsToUpdate).length === 0) {
        return res.status(400).json({ success: false, message: "No valid fields provided for update." });
    }

    try {
        const [updatedRowsCount] = await User.update(
            fieldsToUpdate,
            {
                where: { id: parseInt(userId, 10) },
            }
        );

        if (updatedRowsCount === 0) {
            // या तो User मिला नहीं, या कोई बदलाव नहीं हुआ
            return res.status(404).json({ success: false, message: "User not found or no changes made." });
        }
        
        // अपडेटेड यूजर डेटा को पासवर्ड के बिना वापस लाएँ
        const updatedUser = await User.findByPk(userId, {
            attributes: { exclude: ['password'] }
        });

        res.status(200).json({
            success: true,
            message: "User data updated successfully.",
            data: updatedUser,
        });
    } catch (error) {
        console.error("❌ User update failed:", error);
        res.status(500).json({ success: false, message: "Failed to update user data due to a server error." });
    }
};


// 💡 सभी 4 फ़ंक्शंस को एक्सपोर्ट करें
module.exports = { 
    getRegularUsers,
    getAllAdmins,
    deleteUser, 
    updateUserData
};