const { PrismaClient } = require('@prisma/client');
const { getAIChatResponse } = require('../services/aiService');
const prisma = new PrismaClient();

const handleChat = async (req, res) => {
    const { message } = req.body;
    const userId = req.user.id;

    if (!message) {
        return res.status(400).json({ success: false, message: 'Message is required.' });
    }
    try {
        await prisma.chatMessage.create({
            data: { userId, sender: 'USER', message },
        });
        const botResponse = await getAIChatResponse(message);
        await prisma.chatMessage.create({
            data: { userId, sender: 'BOT', message: botResponse },
        });
        res.json({ success: true, reply: botResponse });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get chat response.' });
    }
};

const getAllChats = async (req, res) => {
    try {
        const messages = await prisma.chatMessage.findMany({
            orderBy: { createdAt: 'asc' },
            include: { user: { select: { email: true } } },
        });
        const chatsBySession = messages.reduce((acc, msg) => {
            const sessionId = msg.user.email;
            if (!acc[sessionId]) acc[sessionId] = [];
            acc[sessionId].push(msg);
            return acc;
        }, {});
        res.json({ success: true, data: chatsBySession });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch chats.' });
    }
};

module.exports = { handleChat, getAllChats };