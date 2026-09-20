/**
 * @file controllers/adminController.js
 * @description TITAN ADMIN BRAIN (Gen-6)
 * @capabilities Transactional Deletion, Mass Notification Batching, High-Speed Queries
 */

const { sequelize } = require('../config/db'); // Imported sequelize instance directly from config/db for transactions
const { Op } = require('sequelize');
const admin = require('../config/firebase'); // Firebase Admin SDK

// âœ… CORRECT IMPORT: Models ko seedha central hub se load karein (Faster & Cleaner)
const { User, Admin, ChatMessage, NotificationToken, PaymentLog } = require('../models');

// ðŸ“Š Optimized Selection: Sirf wahi data mangaayein jo dashboard par dikhana hai
const userSelectFields = [
    'id', 'fullName', 'googleId', 'email', 'phone', 'role', 'status', 'autoPayStatus', 'createdAt'
];

// =======================================================
// 1ï¸âƒ£ GET REGULAR USERS (Optimized for Dashboard)
// =======================================================
const getRegularUsers = async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: userSelectFields,
            order: [['createdAt', 'DESC']],
        });
        
        res.status(200).json({ success: true, count: users.length, data: users });
    } catch (error) {
        console.error('âŒ Fetch Users Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to retrieve user registry.' });
    }
};

// =======================================================
// 2ï¸âƒ£ GET ALL ADMINS (Team View - From Separate Admin Model)
// =======================================================
const getAllAdmins = async (req, res) => {
    try {
        const admins = await Admin.findAll({
            attributes: ['id', 'name', 'email', 'role', 'status', 'isApproved', 'createdAt'],
            order: [['createdAt', 'DESC']],
        });
        res.status(200).json({ success: true, data: admins });
    } catch (error) {
        console.error('âŒ Fetch Admins Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to retrieve admin registry.' });
    }
};

// =======================================================
// 3ï¸âƒ£ DELETE USER (Atomic Transaction - ASI Level) ðŸ›¡ï¸
// =======================================================
const deleteUser = async (req, res) => {
    const { userId } = req.params;
    
    // ðŸš¦ Start Transaction: Sab kuch delete hoga, ya kuch bhi nahi.
    const t = await sequelize.transaction(); // Using imported sequelize instance directly

    try {
        // Self-Destruct Prevention (Support both UUID string and integer ID comparison without breaking UUIDs)
        const currentAdminId = String(req.user.id);
        const targetUserId = String(userId);
        if (currentAdminId === targetUserId) {
            await t.rollback();
            return res.status(403).json({ success: false, message: "Security Alert: Cannot delete yourself." });
        }

        console.log(`ðŸ—‘ï¸ [DELETE] Initiating wipe for User ID: ${userId}`);

        // Step 1: Delete Chat History
        await ChatMessage.destroy({ where: { userId }, transaction: t });
        
        // Step 2: Remove Notification Linkages (Clean dead tokens)
        if (NotificationToken) {
            await NotificationToken.destroy({ where: { userId }, transaction: t });
        }

        // Step 3: Delete the User Account
        const deletedCount = await User.destroy({ where: { id: userId }, transaction: t });

        // âœ… Commit Changes
        await t.commit();

        if (deletedCount === 0) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        console.log(`âœ… [DELETE] User ${userId} wiped successfully.`);
        res.status(200).json({ success: true, message: "User and all associated data wiped." });

    } catch (error) {
        // â†©ï¸ Rollback: Undo everything if error occurs
        await t.rollback();
        console.error("âŒ User Wipe Error:", error);
        res.status(500).json({ success: false, message: "Deletion failed due to system lock." });
    }
};

// =======================================================
// 4ï¸âƒ£ UPDATE USER DATA (CRM Operations)
// =======================================================
const updateUserData = async (req, res) => {
    const { userId } = req.params;
    const { fullName, email, rcmId, status, role, autoPayStatus, nextBillingDate } = req.body;

    // Filter valid fields (Security: Prevent pollution)
    const fieldsToUpdate = {};
    if (fullName !== undefined) fieldsToUpdate.fullName = fullName;
    if (email !== undefined) fieldsToUpdate.email = email;
    if (rcmId !== undefined) fieldsToUpdate.rcmId = rcmId;
    if (status !== undefined) fieldsToUpdate.status = status;
    if (role !== undefined) fieldsToUpdate.role = role;
    if (autoPayStatus !== undefined) fieldsToUpdate.autoPayStatus = autoPayStatus;
    
    // Handle Date Object
    if (nextBillingDate === null) fieldsToUpdate.nextBillingDate = null;
    else if (nextBillingDate) fieldsToUpdate.nextBillingDate = new Date(nextBillingDate);

    try {
        if (Object.keys(fieldsToUpdate).length === 0) {
            return res.status(400).json({ success: false, message: "No changes detected." });
        }

        const [updated] = await User.update(fieldsToUpdate, { where: { id: userId } });

        if (!updated) {
            return res.status(404).json({ success: false, message: "User not found or data identical." });
        }
        
        // Return fresh data
        const updatedUser = await User.findByPk(userId, { attributes: userSelectFields });
        
        res.status(200).json({ 
            success: true, 
            message: "User profile updated.", 
            data: updatedUser 
        });

    } catch (error) {
        console.error("âŒ Update Error:", error);
        res.status(500).json({ success: false, message: "Update failed." });
    }
};

// =======================================================
// 5ï¸âƒ£ âœ¨ TITAN NOTIFICATION BLAST (The Broadcast Engine) ðŸš€
// =======================================================
const pushNotificationToAll = async (req, res) => {
    try {
        const { title, body, imageUrl, link } = req.body;

        if (!title || !body) {
            return res.status(400).json({ success: false, message: "Payload missing (Title/Body)." });
        }

        // 1. Fetch ALL Active Tokens (Raw Query for Speed)
        // 'raw: true' use karne se query 10x fast ho jati hai
        const activeDevices = await NotificationToken.findAll({
            where: { status: 'ACTIVE' },
            attributes: ['token'],
            raw: true
        });

        const tokens = activeDevices.map(d => d.token);
        
        if (tokens.length === 0) {
            return res.status(404).json({ success: false, message: "No active devices found in Titan Grid." });
        }

        console.log(`ðŸ“£ [TITAN BLAST] Targeting ${tokens.length} devices...`);

        // 2. SMART BATCHING (500 per chunk - Firebase Limit)
        const chunks = [];
        const BATCH_SIZE = 500;

        for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
            const chunk = tokens.slice(i, i + BATCH_SIZE);
            
            const message = {
                notification: { title, body },
                data: { 
                    title, 
                    body, 
                    image: imageUrl || "", 
                    url: link || "/",
                    click_action: "FLUTTER_NOTIFICATION_CLICK"
                },
                tokens: chunk
            };

            // Non-blocking Push
            chunks.push(admin.messaging().sendEachForMulticast(message));
        }

        // 3. Parallel Execution (Wait for all batches to fly)
        const results = await Promise.all(chunks);

        // 4. Analytics Calculation
        let successCount = 0;
        let failureCount = 0;
        
        results.forEach(r => {
            successCount += r.successCount;
            failureCount += r.failureCount;
        });

        console.log(`âœ… [BLAST COMPLETE] Success: ${successCount}, Failed: ${failureCount}`);

        res.status(200).json({ 
            success: true, 
            message: `Transmission Complete.`,
            stats: { sent: successCount, failed: failureCount, total: tokens.length }
        });

    } catch (error) {
        console.error("ðŸ”¥ Broadcast System Error:", error);
        res.status(500).json({ success: false, message: "Broadcast interrupted." });
    }
};

// =======================================================
// 6ï¸âƒ£ GET ADMIN METRICS OVERVIEW
// =======================================================
const getMetricsOverview = async (req, res) => {
    try {
        const totalUsers = await User.count();
        const activePaidUsers = await User.count({ where: { status: 'PREMIUM', autoPayStatus: true } });
        const pendingOrFreeUsers = await User.count({ where: { [Op.or]: [{ status: 'pending' }, { status: 'INACTIVE' }, { status: 'active', autoPayStatus: false }] } });
        
        const totalRevenueResult = await PaymentLog.sum('amount', { where: { status: { [Op.in]: ['SUCCESS', 'WEBHOOK_SUCCESS', 'MANDATE_VERIFIED'] } } });
        const totalRevenue = totalRevenueResult || 0;

        const totalSuccessfulTransactions = await PaymentLog.count({ where: { status: { [Op.in]: ['SUCCESS', 'WEBHOOK_SUCCESS', 'MANDATE_VERIFIED'] } } });

        res.status(200).json({
            success: true,
            data: {
                totalUsers,
                activePaidUsers,
                pendingOrFreeUsers,
                totalRevenue: parseFloat(totalRevenue).toFixed(2),
                totalSuccessfulTransactions,
            }
        });
    } catch (error) {
        console.error('âŒ Get Metrics Overview Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to retrieve metrics overview.' });
    }
};

// =======================================================
// 7ï¸âƒ£ GET PAGINATED PAYMENT LOGS
// =======================================================
const getPaymentLogs = async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status; // e.g., 'SUCCESS', 'PENDING', 'FAILED'

    let whereClause = {};
    if (statusFilter === 'Completed / Paid') {
        whereClause.status = { [Op.in]: ['SUCCESS', 'WEBHOOK_SUCCESS', 'MANDATE_VERIFIED'] };
    } else if (statusFilter === 'Pending / Failed') {
        whereClause.status = { [Op.in]: ['INITIATED', 'FAILED', 'CANCELLED', 'HALTED'] };
    }
    // For 'All', no specific status filter is applied

    try {
        const { count, rows: paymentLogs } = await PaymentLog.findAndCountAll({
            where: whereClause,
            include: [{
                model: User,
                as: 'User',
                attributes: ['id', 'fullName', 'email', 'rcmId', 'phone'],
            }],
            order: [['createdAt', 'DESC']],
            limit,
            offset,
        });

        const formattedLogs = paymentLogs.map(log => ({
            id: log.id,
            userId: log.userId,
            userName: log.User ? log.User.fullName : 'N/A',
            userEmail: log.User ? log.User.email : 'N/A',
            userRcmId: log.User ? log.User.rcmId : 'N/A',
            paymentId: log.paymentId,
            subscriptionId: log.subscriptionId,
            amount: parseFloat(log.amount).toFixed(2),
            status: log.status,
            method: log.method,
            date: log.createdAt,
        }));

        res.status(200).json({
            success: true,
            currentPage: page,
            totalPages: Math.ceil(count / limit) || 1,
            totalItems: count,
            data: formattedLogs,
        });

    } catch (error) {
        console.error('âŒ Get Payment Logs Error:', error.message);
        res.status(500).json({ success: false, message: 'Failed to retrieve payment logs.' });
    }
};

// =======================================================
// 8️⃣ APPROVE ADMIN (IAM)
// =======================================================
const approveAdmin = async (req, res) => {
    const { adminId } = req.params;
    try {
        const targetAdmin = await Admin.findByPk(adminId);
        if (!targetAdmin) {
            return res.status(404).json({ success: false, message: "Admin not found." });
        }

        await targetAdmin.update({
            isApproved: true,
            status: 'active'
        });

        res.status(200).json({
            success: true,
            message: "Admin approved successfully.",
            data: {
                id: targetAdmin.id,
                email: targetAdmin.email,
                isApproved: targetAdmin.isApproved,
                status: targetAdmin.status
            }
        });
    } catch (error) {
        console.error("❌ Approve Admin Error:", error);
        res.status(500).json({ success: false, message: "Failed to approve admin." });
    }
};

// =======================================================
// ✅ MODULE EXPORTS
// =======================================================
module.exports = {
    getRegularUsers,
    getAllAdmins,
    deleteUser,
    updateUserData,
    pushNotificationToAll,
    approveAdmin,
    getMetricsOverview,
    getPaymentLogs,
};
