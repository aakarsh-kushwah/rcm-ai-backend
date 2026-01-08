const { db } = require('../config/db');
const { Op } = require('sequelize'); 

// ❌ OLD (WRONG): This runs too early, before DB connects
// const { User, ChatMessage, sequelize } = db; 

// User selection fields
const userSelectFields = [
    'id', 'fullName', 'rcmId', 'email', 'phone', 'role', 'status', 'autoPayStatus', 'createdAt'
];

// =======================================================
// 1️⃣ GET ALL REGULAR USERS
// =======================================================
const getRegularUsers = async (req, res) => {
    try {
        // ✅ FIX: Access Model HERE (Inside the function)
        // Jab request aayegi, tab tak DB connect ho chuka hoga.
        const User = db.User; 

        if (!User) {
            console.error("❌ DB Error: User model missing in db object.");
            return res.status(500).json({ success: false, message: 'Server error: User model is not available.' });
        }

        const users = await User.findAll({
            where: { 
                role: { [Op.ne]: 'ADMIN' } 
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
// 2️⃣ GET ALL ADMINS
// =======================================================
const getAllAdmins = async (req, res) => {
    try {
        const User = db.User; // ✅ Access inside function

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
// 3️⃣ DELETE USER
// ============================================================
const deleteUser = async (req, res) => {
    const { userId } = req.params;

    // ✅ Access Models & Sequelize instance inside function
    const User = db.User;
    const ChatMessage = db.ChatMessage;
    const sequelize = db.sequelize;

    if (!User || !ChatMessage || !sequelize) {
        return res.status(500).json({ success: false, message: 'Server models not fully ready for operation.' });
    }

    if (req.user && req.user.id === parseInt(userId, 10)) {
        return res.status(403).json({
            success: false,
            message: "You cannot delete your own admin account.",
        });
    }

    const transaction = await sequelize.transaction();

    try {
        await ChatMessage.destroy({
            where: { userId: parseInt(userId, 10) },
            transaction,
        });

        const deletedUserCount = await User.destroy({
            where: { id: parseInt(userId, 10) },
            transaction,
        });

        await transaction.commit();

        if (deletedUserCount === 0) {
            return res.status(404).json({ success: false, message: "User not found or already deleted." });
        }

        res.status(200).json({
            success: true,
            message: "User and all associated data deleted successfully.",
        });
    } catch (error) {
        await transaction.rollback();
        console.error("❌ User deletion failed:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete user due to a server error.",
        });
    }
};

// ============================================================
// 4️⃣ UPDATE USER DATA
// ============================================================
const updateUserData = async (req, res) => {
    const { userId } = req.params;
    const { fullName, email, rcmId, status, role, autoPayStatus, nextBillingDate } = req.body;
    
    const User = db.User; // ✅ Access inside function

    if (!User) {
        return res.status(500).json({ success: false, message: 'User model is not initialized.' });
    }

    const fieldsToUpdate = {};
    if (fullName !== undefined) fieldsToUpdate.fullName = fullName;
    if (email !== undefined) fieldsToUpdate.email = email;
    if (rcmId !== undefined) fieldsToUpdate.rcmId = rcmId;
    if (status !== undefined) fieldsToUpdate.status = status;
    if (role !== undefined) fieldsToUpdate.role = role;
    if (autoPayStatus !== undefined) fieldsToUpdate.autoPayStatus = autoPayStatus;
    
    if (nextBillingDate === null) {
        fieldsToUpdate.nextBillingDate = null;
    } else if (nextBillingDate) {
        fieldsToUpdate.nextBillingDate = new Date(nextBillingDate);
    }
    
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
            return res.status(404).json({ success: false, message: "User not found or no changes made." });
        }
        
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

module.exports = { 
    getRegularUsers,
    getAllAdmins,
    deleteUser, 
    updateUserData
};