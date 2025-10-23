const { getAIChatResponse } = require('../services/aiService'); 
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// CRITICAL FIX: Ensure System Prompt has mandatory content
const SYSTEM_PROMPT = "You are the RCM AI assistant. Provide concise and accurate answers related to RCM products, business, and leader information. Maintain a helpful and professional tone.";

const handleChat = async (req, res) => {
    // Logic for user chat submission (POST /api/chat)
    const { message } = req.body; 
    const userId = req.user ? req.user.id : null; 

    if (!message) {
        return res.status(400).json({ success: false, message: "Message content cannot be empty." });
    }

    try {
        // 1. Construct the message array
        const groqMessages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: message }
        ];

        // 2. Get response from AI Service
        const reply = await getAIChatResponse(groqMessages);

        // 3. Save chat history
        if (userId) {
            await prisma.chatMessage.createMany({
                data: [
                    { userId: userId, sender: 'USER', message: message },
                    { userId: userId, sender: 'BOT', message: reply },
                ]
            });
        }
        
        // 4. Send successful response
        res.status(200).json({ success: true, reply: reply });

    } catch (error) {
        console.error("Chat Error:", error);
        const statusCode = error.status || 500; 
        res.status(statusCode).json({ success: false, message: error.message || "An unexpected error occurred during AI processing." });
    }
};

/**
 * Admin function to retrieve all chat messages segmented by user.
 * This function is mapped to GET /api/chat/admin/chats.
 */
const getAllChats = async (req, res) => {
    try {
        const allMessages = await prisma.chatMessage.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                sender: true,
                message: true,
                createdAt: true,
                user: {
                    select: {
                        email: true // Use email to group chats on the frontend
                    }
                }
            }
        });

        // Group messages by user email for frontend display
        const chatsByUser = allMessages.reduce((acc, msg) => {
            const email = msg.user.email;
            if (!acc[email]) {
                acc[email] = [];
            }
            acc[email].push({
                sender: msg.sender,
                message: msg.message,
                createdAt: msg.createdAt
            });
            return acc;
        }, {});

        res.status(200).json({ success: true, data: chatsByUser });

    } catch (error) {
        console.error("Admin Chat Fetch Error:", error);
        res.status(500).json({ success: false, message: "Failed to retrieve chat history." });
    }
};


module.exports = { handleChat, getAllChats };