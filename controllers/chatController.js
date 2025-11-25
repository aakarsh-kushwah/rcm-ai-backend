const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// ============================================================
// 🔹 1. Handle User Chat (Text) - Groq AI
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message required" });
    }

    // 1. Message Structure for Groq
    let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    
    if (chatHistory && Array.isArray(chatHistory)) {
        groqMessages = [...groqMessages, ...chatHistory];
    }
    groqMessages.push({ role: "user", content: message });
    
    // 2. Get AI Response
    const replyString = await getAIChatResponse(groqMessages);

    // 3. Parse Response safely
    let replyContent = "";
    let jsonReply = null;

    try {
        jsonReply = JSON.parse(replyString);
        replyContent = jsonReply.content || jsonReply.text || replyString;
        // Ensure structure consistency
        if (!jsonReply.type) jsonReply = { type: 'text', content: replyContent };
    } catch (e) {
        replyContent = replyString;
        jsonReply = { type: 'text', content: replyString };
    }

    // 4. Save History to DB
    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Speak (Voice) - SWITCHED TO OPENAI TTS 🚀
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    // ✅ Ab hum OpenAI Key use karenge (ElevenLabs nahi)
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 

    if (!text) return res.status(400).json({ error: 'Text is required' });
    
    if (!OPENAI_API_KEY) {
        console.error("❌ CRITICAL: OPENAI_API_KEY is missing in Render Environment!");
        return res.status(500).json({ error: 'Server Config Error: OpenAI Key Missing' });
    }

    try {
        // console.log("📡 Generating Voice via OpenAI...");

        const response = await axios({
            method: 'POST',
            url: 'https://api.openai.com/v1/audio/speech',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            data: {
                model: "tts-1", // 'tts-1-hd' for ultra high quality (slower)
                input: text,
                voice: "nova",  // Options: alloy, echo, fable, onyx, nova, shimmer
                response_format: "mp3",
                speed: 1.0
            },
            responseType: 'stream' // Stream audio directly to frontend
        });

        // Send Audio Stream
        res.set('Content-Type', 'audio/mpeg');
        response.data.pipe(res);

    } catch (error) {
        console.error('🔥 OpenAI Voice Error:', error.response?.data || error.message);
        
        if (error.response?.status === 401) {
            console.error("❌ Cause: Invalid OpenAI API Key.");
        }
        
        res.status(500).json({ error: 'Failed to generate voice' });
    }
});

// ============================================================
// 🔹 3. Admin: Get All Chats
// ============================================================
const getAllChats = asyncHandler(async (req, res) => {
    const allMessages = await db.ChatMessage.findAll({
      include: [
        {
          model: db.User,
          attributes: ["email"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const chatsByUser = {};
    allMessages.forEach((msg) => {
      const email = msg.User ? msg.User.email : "Unknown User";
      if (!chatsByUser[email]) chatsByUser[email] = [];
      chatsByUser[email].push({
        sender: msg.sender,
        message: msg.message,
        createdAt: msg.createdAt,
      });
    });

    res.status(200).json({ success: true, data: chatsByUser });
});

module.exports = { handleChat, handleSpeak, getAllChats };