const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler'); // ✅ Yeh line missing thi
const axios = require('axios');

// ============================================================
// 🔹 1. Handle User Chat (Text)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message required" });
    }

    // Prepare messages for AI
    let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    
    if (chatHistory && Array.isArray(chatHistory)) {
        groqMessages = [...groqMessages, ...chatHistory];
    }
    groqMessages.push({ role: "user", content: message });
    
    // Get AI Response
    const replyString = await getAIChatResponse(groqMessages);

    // Parse JSON Response
    let replyContent = "";
    let jsonReply = null;

    try {
        jsonReply = JSON.parse(replyString);
        replyContent = jsonReply.content || jsonReply.text || replyString;
        if (!jsonReply.type) jsonReply = { type: 'text', content: replyContent };
    } catch (e) {
        replyContent = replyString;
        jsonReply = { type: 'text', content: replyString };
    }

    // Save to DB
    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Speak (Voice with Debugging)
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    
    // Voice ID: "Rachel" (Professional) 
    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

    // 🔍 Debug Logs
    console.log("🎤 Voice Request Received:", text ? "Text Present" : "No Text");

    if (!text) return res.status(400).json({ error: 'Text is required' });
    
    if (!ELEVENLABS_API_KEY) {
        console.error("❌ CRITICAL: ELEVENLABS_API_KEY missing in Environment Variables!");
        return res.status(500).json({ error: 'Server Config Error: Voice Key Missing' });
    }

    try {
        console.log("📡 Calling ElevenLabs API...");
        
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
            headers: {
                'Accept': 'audio/mpeg',
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
            },
            data: {
                text: text,
                model_id: "eleven_monolingual_v1", // Low latency model
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            },
            responseType: 'stream' // ⚡ Important: Stream audio
        });

        console.log("✅ Voice Generated Successfully. Streaming to client...");
        res.set('Content-Type', 'audio/mpeg');
        response.data.pipe(res);

    } catch (error) {
        // 🔥 Detailed Error Logging for Debugging
        console.error("🔥 ElevenLabs API Failed:");
        if (error.response) {
            console.error("Status:", error.response.status);
            // Note: Stream error data might not be readable directly as JSON, 
            // but status code tells the story.
            if (error.response.status === 401) console.error("👉 Cause: Invalid API Key.");
            if (error.response.status === 429) console.error("👉 Cause: Quota Exceeded (Free limit over).");
        } else {
            console.error("Error Message:", error.message);
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