const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// ============================================================
// 🔹 1. Handle User Chat (Text Logic) - UNCHANGED
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
// 🔹 2. Handle Speak (ElevenLabs Voice) - ✅ FIXED & OPTIMIZED
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    if (!text?.trim()) {
        return res.status(400).json({ error: 'Text is required and cannot be empty' });
    }

    // 1. Robust Key Handling
    // Checks multiple environment variables and trims whitespace
    const ELEVENLABS_API_KEY_RAW = process.env.ELEVENLABS_API_KEY || 
                                   process.env.ELEVENLABS_KEY || 
                                   process.env.ELEVENLABS_SK;
                                   
    const ELEVENLABS_API_KEY = ELEVENLABS_API_KEY_RAW ? ELEVENLABS_API_KEY_RAW.trim() : null;

    const VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Your preferred voice

    // Debug Logs
    console.log("🎤 ElevenLabs Debug:");
    console.log(`- API Key Loaded: ${!!ELEVENLABS_API_KEY}`);
    console.log(`- Key Prefix: ${ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.substring(0, 5) + '...' : 'MISSING'}`);
    
    if (!ELEVENLABS_API_KEY) {
        console.error("❌ CRITICAL: No ElevenLabs API key found in any env var!");
        return res.status(500).json({ 
            error: 'Server Config Error: ELEVENLABS_API_KEY missing. Check .env or Render dashboard.' 
        });
    }

    // 2. Safety Limits (Prevent 429 Errors)
    const MAX_CHARS = 2500; // Conservative limit
    const safeText = text.trim().substring(0, MAX_CHARS);

    try {
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
            headers: {
                'Accept': 'audio/mpeg',
                // ✅ Using 'xi-api-key' as verified by your successful test
                'xi-api-key': ELEVENLABS_API_KEY, 
                'Content-Type': 'application/json',
            },
            data: {
                text: safeText,
                // ✅ THE FIX: Switched to 'eleven_multilingual_v2' (Supported on Free Tier)
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                    stability: 0.5, 
                    similarity_boost: 0.8,
                    use_speaker_boost: true
                }
            },
            responseType: 'stream',
            timeout: 30000, // 30s timeout
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
        console.error('🔥 ElevenLabs Error:', error.response?.status);
        
        // Log detailed error message from ElevenLabs if available
        if (error.response?.data) {
             try {
                const errorData = Buffer.isBuffer(error.response.data) 
                    ? error.response.data.toString() 
                    : JSON.stringify(error.response.data);
                console.error('Error Details:', errorData);
             } catch(e) {}
        }

        // Specific Error Handling
        if (error.response?.status === 401) {
            return res.status(401).json({ 
                error: 'Invalid API Key. Please update ELEVENLABS_API_KEY in Render.' 
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