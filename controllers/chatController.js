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
// 🔹 2. Handle Speak (ElevenLabs Voice) - ✅ FIXED FOR 401/429
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    if (!text?.trim()) {
        return res.status(400).json({ error: 'Text is required and cannot be empty' });
    }

    // 🔧 FIXED: Multiple key sources + proper trimming
    const ELEVENLABS_API_KEY_RAW = process.env.ELEVENLABS_API_KEY;
    let ELEVENLABS_API_KEY = null;
    
    if (ELEVENLABS_API_KEY_RAW) {
        ELEVENLABS_API_KEY = ELEVENLABS_API_KEY_RAW.trim();
    } else {
        // Fallback env vars (common naming variations)
        const fallbackKeys = [
            process.env.ELEVENLABS_KEY,
            process.env.ELEVENLABS_SK,
            process.env.API_ELEVENLABS_KEY
        ];
        for (const key of fallbackKeys) {
            if (key?.trim()) {
                ELEVENLABS_API_KEY = key.trim();
                break;
            }
        }
    }

    const VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Your new voice ID

    // 🔧 ENHANCED Debug logging (safe for production)
    console.log("🎤 ElevenLabs Debug:");
    console.log("- API Key loaded:", !!ELEVENLABS_API_KEY);
    console.log("- Key prefix:", ELEVENLABS_API_KEY ? `${ELEVENLABS_API_KEY.substring(0, 4)}...` : 'MISSING');
    console.log("- Text length:", text.length);
    console.log("- Voice ID:", VOICE_ID);
    console.log("─".repeat(50));

    if (!ELEVENLABS_API_KEY) {
        console.error("❌ CRITICAL: No ElevenLabs API key found in any env var!");
        return res.status(500).json({ 
            error: 'Server Config Error: ELEVENLABS_API_KEY missing. Check .env or Render dashboard.' 
        });
    }

    // 🔧 FIXED: Text truncation to prevent 429
    const MAX_CHARS = 3000; // Conservative limit for free tier
    const safeText = text.trim().substring(0, MAX_CHARS);
    
    if (text.length > MAX_CHARS) {
        console.warn(`📏 Text truncated: ${text.length} → ${MAX_CHARS} chars`);
    }

    try {
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
            headers: {
                'Accept': 'audio/mpeg',
                // 🔧 CRITICAL FIX: Use BOTH headers (Bearer is now standard)
                'Authorization': `Bearer ${ELEVENLABS_API_KEY}`,
                'xi-api-key': ELEVENLABS_API_KEY, // Legacy fallback
                'Content-Type': 'application/json',
            },
            data: {
                text: safeText,
                // 🔧 UPDATED: More efficient multilingual model
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.8,
                    style: 0,
                    use_speaker_boost: true
                }
            },
            responseType: 'stream',
            timeout: 25000, // 25s timeout
            maxContentLength: 10 * 1024 * 1024 // 10MB
        });

        console.log("✅ Voice generated successfully");
        console.log("- Rate limits:", {
            remaining: response.headers['x-ratelimit-remaining'],
            reset: response.headers['x-ratelimit-reset']
        });

        // Stream audio with proper headers
        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': response.headers['content-length'],
            'Cache-Control': 'no-cache, no-store',
            'Connection': 'keep-alive'
        });
        
        response.data.pipe(res);

    } catch (error) {
        console.error('🔥 ElevenLabs Error:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            headers: error.response?.headers,
            message: error.message
        });

        // 🔧 SPECIFIC ERROR HANDLING
        if (error.response?.status === 401) {
            return res.status(401).json({ 
                error: 'Invalid API Key. Regenerate at elevenlabs.io/app/settings/api-keys and update ELEVENLABS_API_KEY' 
            });
        }
        
        if (error.response?.status === 404) {
            return res.status(404).json({ 
                error: `Voice "${VOICE_ID}" not found. List voices: GET /v1/voices` 
            });
        }

        if (error.response?.status === 429) {
            const retryAfter = error.response.headers['retry-after'] || 60;
            return res.status(429).json({ 
                error: 'Quota exceeded (free tier ~10k chars/month). Upgrade or wait.',
                retryAfter: parseInt(retryAfter)
            });
        }

        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return res.status(408).json({ error: 'Request timeout. Try shorter text.' });
        }

        res.status(500).json({ 
            error: 'Voice generation failed. Check server logs for details.' 
        });
    }
});

const getAllChats = asyncHandler(async (req, res) => { /* Placeholder */ });

module.exports = { handleChat, handleSpeak, getAllChats };
