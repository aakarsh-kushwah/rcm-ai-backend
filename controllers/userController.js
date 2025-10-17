// Example: controllers/adminController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// This function fetches all users for the Admin panel
const getAllUsers = async (req, res) => {
    // Note: Assume an isAdmin middleware has already verified the token and role.
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                fullName: true,
                rcmId: true,
                email: true,
                phone: true,
                role: true,
                // Do NOT select the password field
            }
        });
        res.json({ success: true, data: users });
    } catch (error) {
        console.error("Error fetching all users:", error);
        res.status(500).json({ success: false, message: 'Internal server error while fetching users.' });
    }
};

module.exports = { 
    getAllUsers 
};