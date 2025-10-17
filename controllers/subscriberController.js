const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const addSubscriber = async (req, res) => {
    const { name, phone } = req.body;
    if (!name || !phone) {
        return res.status(400).json({ success: false, message: 'Name and phone number are required.' });
    }
    try {
        const newSubscriber = await prisma.subscriber.create({
            data: { name, phone_number: phone },
        });
        res.status(201).json({ success: true, message: 'Successfully subscribed!', data: newSubscriber });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to subscribe.' });
    }
};

const getAllSubscribers = async (req, res) => {
    try {
        const subscribers = await prisma.subscriber.findMany({
            orderBy: { subscribed_at: 'desc' },
        });
        res.json({ success: true, data: subscribers });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch subscribers.' });
    }
};

module.exports = { addSubscriber, getAllSubscribers };