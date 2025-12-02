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
// 🔹 2. Handle Speak (ElevenLabs Voice) - FIXED ✅
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    if (!text?.trim()) {
        return res.status(400).json({ error: 'Text is required and cannot be empty' });
    }

    // 🔧 FIXED: Multiple API key sources + validation
    let apiKey = process.env.ELEVENLABS_API_KEY?.trim() || 
                 process.env.ELEVENLABS_KEY?.trim() ||
                 null;

    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Verify this voice exists in your account

    // 🔧 ENHANCED Debugging
    console.log("🎤 ElevenLabs Request Debug:");
    console.log("- API Key loaded:", !!apiKey);
    console.log("- Key prefix:", apiKey ? apiKey.substring(0, 4) + "..." : "MISSING");
    console.log("- Text length:", text.length);
    console.log("- Voice ID:", VOICE_ID);
    console.log("─".repeat(50));

    if (!apiKey) {
        console.error("❌ CRITICAL: No valid ElevenLabs API key found!");
        return res.status(500).json({ 
            error: 'Server configuration error: ElevenLabs API key missing. Check environment variables.' 
        });
    }

    // 🔧 FIXED: Rate limiting & text truncation
    const MAX_CHARS = 5000; // Safe limit for most plans
    const safeText = text.trim().substring(0, MAX_CHARS);
    
    if (text.length > MAX_CHARS) {
        console.warn(`📏 Text truncated from ${text.length} to ${MAX_CHARS} chars`);
    }

    try {
        const response = await axios.post(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
            {
                text: safeText,
                model_id: "eleven_multilingual_v2", // 🔧 UPDATED: Better multilingual support
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.8, // Slightly higher for clarity
                    style: 0,
                    use_speaker_boost: true
                }
            },
            {
                headers: {
                    'Accept': 'audio/mpeg',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'xi-api-key': apiKey // 🔧 BACKUP: Some endpoints still accept this
                },
                responseType: 'stream',
                timeout: 30000, // 30s timeout
                maxRedirects: 5
            }
        );

        // 🔧 ENHANCED Response headers for debugging
        console.log("✅ Success - Rate limit info:", {
            remaining: response.headers['x-ratelimit-remaining'],
            reset: response.headers['x-ratelimit-reset']
        });

        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': response.headers['content-length'],
            'Cache-Control': 'no-cache'
        });
        
        response.data.pipe(res);

    } catch (error) {
        console.error("🔥 ElevenLabs Error Details:", {
            status: error.response?.status,
            statusText: error.response?.statusText,
            headers: error.response?.headers,
            message: error.message
        });

        // 🔧 COMPREHENSIVE Error Handling
        if (error.response?.status === 401) {
            return res.status(401).json({ 
                error: 'Invalid API key. Please regenerate in ElevenLabs dashboard and update ELEVENLABS_API_KEY env variable.' 
            });
        }
        
        if (error.response?.status === 404) {
            return res.status(404).json({ 
                error: `Voice ID "${VOICE_ID}" not found. Use /v1/voices endpoint to list available voices.` 
            });
        }

        if (error.response?.status === 429) {
            const resetTime = error.response.headers['x-ratelimit-reset'];
            return res.status(429).json({ 
                error: 'Rate limit exceeded. Free tier: ~10k chars/month. Upgrade or wait.',
                retryAfter: resetTime || 60
            });
        }

        if (error.code === 'ECONNABORTED') {
            return res.status(408).json({ error: 'Request timeout. Text too long or server busy.' });
        }

        res.status(500).json({ 
            error: 'Voice generation failed. Check server logs.',
            debug: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

const getAllChats = asyncHandler(async (req, res) => { /* Placeholder */ });

module.exports = { handleChat, handleSpeak, getAllChats };
