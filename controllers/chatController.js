const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// --- Handle Chat (Text) ---
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) return res.status(400).json({ success: false, message: "Message required" });

    let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    
    if (chatHistory && Array.isArray(chatHistory)) {
        groqMessages = [...groqMessages, ...chatHistory];
    }

    groqMessages.push({ role: "user", content: message });
    
    const replyString = await getAIChatResponse(groqMessages);

    let replyContent = "";
    let jsonReply = null;

    try {
        jsonReply = JSON.parse(replyString);
        replyContent = jsonReply.content || jsonReply.text || replyString;
        // Ensure reply structure
        if (!jsonReply.type) jsonReply = { type: 'text', content: replyContent };
    } catch (e) {
        replyContent = replyString;
        jsonReply = { type: 'text', content: replyString };
    }

    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    res.status(200).json({ success: true, reply: jsonReply });
});

// --- Handle Speak (Voice) ---
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

    if (!text) return res.status(400).json({ error: 'Text is required' });
    if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'Voice Key Missing' });

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
                model_id: "eleven_monolingual_v1",
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            },
            responseType: 'stream'
        });

        res.set('Content-Type', 'audio/mpeg');
        response.data.pipe(res);

    } catch (error) {
        // 🔍 Improved Error Logging
        console.error('🔥 Voice API Error Status:', error.response?.status);
        console.error('🔥 Voice API Error Data:', error.response?.data);
        
        if (error.response?.status === 401) {
            console.error("❌ ACTION REQUIRED: Update ELEVENLABS_API_KEY in Render.");
        }
        
        res.status(500).json({ error: 'Failed to generate voice' });
    }
});

const getAllChats = asyncHandler(async (req, res) => { /* Keep existing code */ });

module.exports = { handleChat, handleSpeak, getAllChats };