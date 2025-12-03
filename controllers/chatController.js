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

// ============================================================
// 🔹 2. Handle Speak (ElevenLabs Voice) - ✅ FIXED ERROR LOGGING
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    if (!text?.trim()) {
        return res.status(400).json({ error: 'Text is required and cannot be empty' });
    }

    // 1. Get API Key
    const ELEVENLABS_API_KEY_RAW = process.env.ELEVENLABS_API_KEY || 
                                   process.env.ELEVENLABS_KEY || 
                                   process.env.ELEVENLABS_SK;
                                   
    const ELEVENLABS_API_KEY = ELEVENLABS_API_KEY_RAW ? ELEVENLABS_API_KEY_RAW.trim() : null;

<<<<<<< Updated upstream
    // Use "leo" Voice (Reliable)
    const VOICE_ID = "IvLWq57RKibBrqZGpQrC"; 
=======
    // Use "Rachel" Voice (Reliable)
    const VOICE_ID = ""; 
>>>>>>> Stashed changes
    // Use V2 Model (Required for Free Tier)
    const MODEL_ID = "eleven_multilingual_v2";

    console.log("🎤 ElevenLabs Debug:");
    console.log(`- API Key Loaded: ${!!ELEVENLABS_API_KEY}`);
    console.log(`- Key Prefix: ${ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.substring(0, 5) + '...' : 'MISSING'}`);
    console.log(`- Model: ${MODEL_ID}`);
    
    if (!ELEVENLABS_API_KEY) {
        console.error("❌ CRITICAL: No ElevenLabs API key found!");
        return res.status(500).json({ 
            error: 'Server Config Error: ELEVENLABS_API_KEY missing.' 
        });
    }

    // 2. Safety Truncation
    const MAX_CHARS = 2500; 
    const safeText = text.trim().substring(0, MAX_CHARS);

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
                text: safeText,
                model_id: MODEL_ID, 
                voice_settings: {
                    stability: 0.5, 
                    similarity_boost: 0.8,
                    use_speaker_boost: true
                }
            },
            responseType: 'stream', // Important for audio
            timeout: 30000, 
        });

        console.log("✅ Voice generated successfully");
        
        // Stream audio with proper headers
        res.set({
            'Content-Type': 'audio/mpeg',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
        });
        
        response.data.pipe(res);

    } catch (error) {
        console.error('🔥 ElevenLabs Error Status:', error.response?.status);
        
        // 🔥 CRITICAL FIX: Read the Error Stream to show the REAL message
        if (error.response?.data) {
             try {
                if (typeof error.response.data.on === 'function') {
                    // It's a stream, listen for data chunks
                    error.response.data.on('data', (chunk) => {
                        console.error('🔴 REAL ELEVENLABS ERROR MESSAGE:', chunk.toString());
                    });
                } else {
                    // It's a buffer or object
                    const errorData = Buffer.isBuffer(error.response.data) 
                        ? error.response.data.toString() 
                        : JSON.stringify(error.response.data);
                    console.error('🔴 REAL ELEVENLABS ERROR MESSAGE:', errorData);
                }
             } catch(e) {
                 console.error('Error reading error stream:', e.message);
             }
        }

        // Specific Error Responses
        if (error.response?.status === 401) {
            return res.status(401).json({ 
                error: 'Unauthorized. Check Render Logs for "REAL ELEVENLABS ERROR MESSAGE" to see why.' 
            });
        }
        
        if (error.response?.status === 429) {
            return res.status(429).json({ error: 'Quota exceeded (Free Tier Limit). Please wait or upgrade.' });
        }

        res.status(500).json({ error: 'Voice generation failed.' });
    }
});

const getAllChats = asyncHandler(async (req, res) => { /* Placeholder */ });

module.exports = { handleChat, handleSpeak, getAllChats };