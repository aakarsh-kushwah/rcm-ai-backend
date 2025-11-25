const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios'); // ✅ Ensure axios is installed

// --- 1. Handle Text Chat ---
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) return res.status(400).json({ success: false, message: "Message required" });

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

// --- 2. Handle Voice (Text-to-Speech) ---
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    
    // Voice ID: "Rachel" (Professional) - You can change this ID from ElevenLabs
    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

    if (!text) return res.status(400).json({ error: 'Text is required' });
    
    if (!ELEVENLABS_API_KEY) {
        console.error("❌ Critical: ELEVENLABS_API_KEY missing in Render Environment!");
        return res.status(500).json({ error: 'Server Config Error: Voice Key Missing' });
    }

    try {
        // Call ElevenLabs API
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
                model_id: "eleven_monolingual_v1", // Low latency model for speed
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            },
            responseType: 'stream' // ⚡ Important: Stream audio for speed
        });

        // Pipe audio back to frontend
        res.set('Content-Type', 'audio/mpeg');
        response.data.pipe(res);

    } catch (error) {
        console.error('🔥 ElevenLabs Error:', error.response?.status, error.response?.data);
        res.status(500).json({ error: 'Failed to generate voice' });
    }
});

const getAllChats = asyncHandler(async (req, res) => { /* Implementation... */ });

module.exports = { handleChat, handleSpeak, getAllChats };