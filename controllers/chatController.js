const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// ============================================================
// 🔹 1. Handle User Chat (Text Logic) - Groq AI
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message content is required." });
    }

    // 1. Construct Message Array for AI
    let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    
    // Append history if available
    if (chatHistory && Array.isArray(chatHistory)) {
        // Limit history to last 10 messages to save tokens/speed up
        const recentHistory = chatHistory.slice(-10); 
        groqMessages = [...groqMessages, ...recentHistory];
    }
    groqMessages.push({ role: "user", content: message });
    
    // 2. Get AI Response
    const replyString = await getAIChatResponse(groqMessages);

    // 3. Parse AI Response (Safely handle JSON/Text)
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

    // 4. Save Interaction to Database
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

    // 5. Send Response
    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Speak (Realistic Voice) - ELEVENLABS 🚀
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    // ✅ Render se Key uthayega
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    
    // 🎙️ Voice ID: "Rachel" (Professional & Clear)
    // Ye ID ElevenLabs ki default 'Rachel' voice ki hai
    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

    if (!text) {
        return res.status(400).json({ error: 'Text is required for speech generation.' });
    }
    
    if (!ELEVENLABS_API_KEY) {
        console.error("❌ CRITICAL ERROR: ELEVENLABS_API_KEY is missing in Render Environment Variables!");
        return res.status(500).json({ error: 'Server Configuration Error: Voice Key Missing' });
    }

    try {
        // console.log("📡 Requesting Realistic Voice from ElevenLabs...");

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
                model_id: "eleven_monolingual_v1", // Low latency model
                voice_settings: {
                    stability: 0.5,       // 50% stability allows emotional range
                    similarity_boost: 0.75 // High clarity
                }
            },
            responseType: 'stream' // ⚡ Critical: Stream audio directly to client
        });

        // Pipe the audio stream directly to the frontend
        res.set({
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked'
        });
        
        response.data.pipe(res);

    } catch (error) {
        // Detailed Error Logging
        console.error('🔥 ElevenLabs Voice Generation Failed:', error.message);
        
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data); 

            if (error.response.status === 401) {
                console.error("❌ KEY ERROR: The API Key on Render is invalid or restricted. Please create a new FULL ACCESS key.");
                return res.status(500).json({ error: 'Invalid ElevenLabs API Key configured on server.' });
            }
            if (error.response.status === 429) {
                return res.status(429).json({ error: 'Voice quota exceeded. Free limit reached.' });
            }
        }
        
        res.status(500).json({ error: 'Failed to generate voice. Please try again later.' });
    }
});

// ============================================================
// 🔹 3. Admin: Get All Chats (Grouped by User)
// ============================================================
const getAllChats = asyncHandler(async (req, res) => {
    try {
        const allMessages = await db.ChatMessage.findAll({
            include: [
                {
                    model: db.User,
                    attributes: ["email", "fullName"], 
                },
            ],
            order: [["createdAt", "DESC"]],
            limit: 1000 
        });

        const chatsByUser = {};
        allMessages.forEach((msg) => {
            const userKey = msg.User ? `${msg.User.fullName} (${msg.User.email})` : "Unknown User";
            
            if (!chatsByUser[userKey]) {
                chatsByUser[userKey] = [];
            }
            
            chatsByUser[userKey].push({
                sender: msg.sender,
                message: msg.message,
                createdAt: msg.createdAt,
            });
        });

        res.status(200).json({ success: true, data: chatsByUser });
    } catch (error) {
        console.error("Admin Fetch Error:", error);
        res.status(500).json({ success: false, message: "Failed to retrieve chat history." });
    }
});

module.exports = { handleChat, handleSpeak, getAllChats };