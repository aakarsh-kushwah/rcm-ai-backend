const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// This function will be mapped to DELETE /api/admin/users/:userId
const deleteUser = async (req, res) => {
    const { userId } = req.params;
    
    // Check if the user is trying to delete themselves (Security check)
    if (req.user && req.user.id === parseInt(userId)) {
        return res.status(403).json({ success: false, message: "You cannot delete your own admin account." });
    }

    try {
        // 1. Delete all associated chat messages first (due to foreign key constraints)
        await prisma.chatMessage.deleteMany({
            where: { userId: parseInt(userId) },
        });

        // 2. Delete the user
        const deletedUser = await prisma.user.delete({
            where: { id: parseInt(userId) },
        });

        res.status(200).json({ success: true, message: 'User and all associated data deleted successfully.', data: deletedUser });

    } catch (error) {
        // P2025: Record not found
        if (error.code === 'P2025') {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        console.error("User deletion failed:", error);
        res.status(500).json({ success: false, message: 'Failed to delete user due to a server error.' });
    }
};

// This function updates user data (used for toggling auto-pay)
const updateUserData = async (req, res) => {
    const { userId } = req.params;
    const { autoPayStatus, nextBillingDate } = req.body; // Expecting these fields

    try {
        const updatedUser = await prisma.user.update({
            where: { id: parseInt(userId) },
            data: {
                autoPayStatus: autoPayStatus,
                nextBillingDate: nextBillingDate ? new Date(nextBillingDate) : undefined,
            },
        });
        res.status(200).json({ success: true, message: 'User data updated successfully.', data: updatedUser });

    } catch (error) {
        if (error.code === 'P2025') {
            return res.status(404).json({ success: false, message: 'User not found for update.' });
        }
        console.error("User update failed:", error);
        res.status(500).json({ success: false, message: 'Failed to update user data.' });
    }
};

module.exports = { deleteUser, updateUserData }; // Export new functions
