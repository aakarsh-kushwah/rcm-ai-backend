const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// ============================================================
// 🔹 1. Handle User Chat (Text Logic) - Groq AI
// (Code unchanged - Focus is on TTS)
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
    
    // ✅ 1. Render Environment Variable से Key उठाएगा
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    
    // 🎙️ Voice ID: Environment Variable Preferred, Fallback to 'Domi' (Multilingual V2 compatible)
    // NOTE: आप अपनी custom Hindi voice ID यहाँ Environment Variable में सेट कर सकते हैं।
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "LruHrtVF6PSyGItzMNHS"; 

    if (!text) {
        return res.status(400).json({ error: 'Text is required for speech generation.' });
    }
    
    if (!ELEVENLABS_API_KEY) {
        console.error("❌ CRITICAL ERROR: ELEVENLABS_API_KEY is missing in Render Environment Variables!");
        // 500 status code ही रखें क्योंकि यह server-side config error है
        return res.status(500).json({ error: 'Server Configuration Error: ElevenLabs Key Missing' }); 
    }

    try {
        console.log(`📡 Requesting Realistic Voice for ID: ${VOICE_ID}`);

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
                // ⚡ FIX: Multilingual support के लिए eleven_multilingual_v2 का उपयोग करें
                model_id: "eleven_multilingual_v2", 
                voice_settings: {
                    stability: 0.5, 
                    similarity_boost: 0.75 
                }
            },
            responseType: 'stream' // Critical: Stream audio directly to client
        });

        // 4. Pipe the audio stream directly to the frontend
        res.set({
            'Content-Type': 'audio/mpeg', // ✅ Correct MIME type for audio stream
            'Cache-Control': 'no-cache', // Ensure browser re-fetches each time
        });
        
        response.data.pipe(res);

    } catch (error) {
        // Detailed Error Logging
        console.error('🔥 ElevenLabs Voice Generation Failed:', error.message);
        
        if (error.response) {
            console.error('   Status:', error.response.status);
            // ElevenLabs error details often come in the response data stream
            // Since responseType is 'stream', we can't easily read JSON error body here.
            // A common fix is to read the stream for logs or use responseType: 'arraybuffer' first.
            if (error.response.status === 401) {
                console.error("❌ API Key is invalid or restricted.");
                return res.status(401).json({ error: 'Invalid ElevenLabs API Key configured on server.' });
            }
            if (error.response.status === 429) {
                return res.status(429).json({ error: 'Voice quota exceeded. Free limit reached.' });
            }
        }
        
        res.status(500).json({ error: 'Failed to generate voice. Internal Server Error.' });
    }
});

// ============================================================
// 🔹 3. Admin: Get All Chats (Grouped by User)
// (Code unchanged)
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