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

    if (!message) return res.status(400).json({ success: false, message: "Message required" });

    // 1. Message Context
    let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    if (chatHistory && Array.isArray(chatHistory)) {
        groqMessages = [...groqMessages, ...chatHistory];
    }
    groqMessages.push({ role: "user", content: message });
    
    // 2. Get AI Response
    const replyString = await getAIChatResponse(groqMessages);

    // 3. Parse Response
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

    // 4. Save History
    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Speak (ElevenLabs Voice) 🚀
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    // ✅ ElevenLabs API Key from Render Environment
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

    // 🎙️ Voice ID: "Rachel" (American, Clear, Professional)
    // You can change this ID from ElevenLabs Voice Library
    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

    console.log("🎤 Generating Voice for:", text ? text.substring(0, 20) + "..." : "Empty");

    if (!text) return res.status(400).json({ error: 'Text is required' });
    
    if (!ELEVENLABS_API_KEY) {
        console.error("❌ CRITICAL: ELEVENLABS_API_KEY missing on Render!");
        return res.status(500).json({ error: 'Server Config Error: Key Missing' });
    }

    try {
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
                    stability: 0.5,       // Balanced emotion
                    similarity_boost: 0.75 // Clear voice
                }
            },
            responseType: 'stream' // ⚡ Stream audio directly
        });

        // Stream the audio back to frontend
        res.set('Content-Type', 'audio/mpeg');
        response.data.pipe(res);

    } catch (error) {
        // 🔥 Better Error Logging for Debugging
        console.error('🔥 ElevenLabs Voice Error:', error.response?.status);
        
        if (error.response) {
             // Read stream error data if possible (Tricky with streams)
             if (error.response.status === 401) {
                 console.error("👉 ACTION: API Key is INVALID or RESTRICTED.");
                 return res.status(500).json({ error: "Invalid API Key on Server" });
             }
             if (error.response.status === 429) {
                 console.error("👉 ACTION: Quota Exceeded (Free tier limit reached).");
                 return res.status(429).json({ error: "Voice Quota Exceeded" });
             }
        }

        res.status(500).json({ error: 'Failed to generate voice' });
    }
});

const getAllChats = asyncHandler(async (req, res) => { /* ... */ });

module.exports = { handleChat, handleSpeak, getAllChats };
