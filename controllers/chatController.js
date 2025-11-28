const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// ============================================================
// 🔹 1. Handle User Chat (Text Logic)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message content is required." });
    }

    // 1. Message Structure for AI
    let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    
    if (chatHistory && Array.isArray(chatHistory)) {
        const recentHistory = chatHistory.slice(-10); 
        groqMessages = [...groqMessages, ...recentHistory];
    }
    groqMessages.push({ role: "user", content: message });
    
    // 2. Get AI Response
    const replyString = await getAIChatResponse(groqMessages);

    // 3. Parse AI Response
    let replyContent = "";
    let jsonReply = null;

    try {
        jsonReply = JSON.parse(replyString);
        replyContent = jsonReply.content || jsonReply.text || replyString;
        if (!jsonReply.type) {
            jsonReply = { type: 'text', content: replyContent };
        }
    } catch (e) {
        replyContent = replyString;
        jsonReply = { type: 'text', content: replyString };
    }

    // 4. Save to DB
    if (userId) {
        try {
            await db.ChatMessage.bulkCreate([
                { userId, sender: "USER", message: message },
                { userId, sender: "BOT", message: replyContent }, 
            ]);
        } catch (dbError) {
            console.error("⚠️ Chat History Save Failed:", dbError.message);
        }
    }

    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Speak (Voice Logic) - OpenAI TTS 🚀
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    // ✅ Using OpenAI API Key
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 

    if (!text) {
        return res.status(400).json({ error: 'Text is required for speech generation.' });
    }
    
    if (!OPENAI_API_KEY) {
        console.error("❌ CRITICAL ERROR: OPENAI_API_KEY is missing in Render Environment Variables!");
        return res.status(500).json({ error: 'Server Configuration Error: AI Voice Key Missing' });
    }

    try {
        // Call OpenAI Audio API
        const response = await axios({
            method: 'POST',
            url: 'https://api.openai.com/v1/audio/speech',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            data: {
                model: "tts-1",
                input: text,
                voice: "nova",  // 'nova' is energetic & professional
                response_format: "mp3",
                speed: 1.0
            },
            responseType: 'stream'
        });

        // Pipe the audio stream directly to the frontend
        res.set({
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked'
        });
        
        response.data.pipe(res);

    } catch (error) {
        console.error('🔥 OpenAI Voice Generation Failed:', error.message);
        res.status(500).json({ error: 'Failed to generate voice. Please try again later.' });
    }
});

// ============================================================
// 🔹 3. Admin: Get All Chats
// ============================================================
const getAllChats = asyncHandler(async (req, res) => {
    try {
        const allMessages = await db.ChatMessage.findAll({
            include: [{ model: db.User, attributes: ["email", "fullName"] }],
            order: [["createdAt", "DESC"]],
            limit: 1000 
        });

        const chatsByUser = {};
        allMessages.forEach((msg) => {
            const userKey = msg.User ? `${msg.User.fullName} (${msg.User.email})` : "Unknown User";
            if (!chatsByUser[userKey]) chatsByUser[userKey] = [];
            chatsByUser[userKey].push({
                sender: msg.sender,
                message: msg.message,
                createdAt: msg.createdAt,
            });
        });

        res.status(200).json({ success: true, data: chatsByUser });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to retrieve chat history." });
    }
});

// ✅ IMPORTANT: Make sure 'handleSpeak' is exported here!
module.exports = { handleChat, handleSpeak, getAllChats };