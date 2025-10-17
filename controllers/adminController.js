// backend/controllers/adminController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const userSelectFields = {
    id: true, fullName: true, rcmId: true, email: true, phone: true, role: true, createdAt: true,
};

// 1. Fetches only users with role 'USER' (for User Management table)
const getRegularUsers = async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            where: { role: 'USER' },
            select: userSelectFields,
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, data: users });
    } catch (error) {
        console.error("Error fetching regular users:", error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

// 2. Fetches only users with role 'ADMIN' (for Admin Management table)
const getAllAdmins = async (req, res) => {
    try {
        const admins = await prisma.user.findMany({
            where: { role: 'ADMIN' },
            select: userSelectFields,
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, data: admins });
    } catch (error) {
        console.error("Error fetching admins:", error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

module.exports = { getRegularUsers, getAllAdmins };