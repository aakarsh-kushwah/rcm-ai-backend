const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');

// ============================================================
// 🔹 1. Handle User Chat (Smart FAQ + AI Fallback)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) return res.status(400).json({ success: false, message: "Message required" });

    let replyContent = "";
    let audioUrl = null;
    let source = "AI";

    // --- 🕵️ STEP A: Check FAQ Database (Zero Cost Strategy) ---
    // Checks if the user's question matches any "Smart Response" stored by Admin
    try {
        const faqMatch = await db.FAQ.findOne({
            where: {
                question: { [Op.substring]: message.trim() } // Partial match (e.g., "what is rcm" matches "what is rcm business")
            }
        });

        if (faqMatch) {
            console.log(`✅ FAQ HIT: Serving pre-set answer for "${message}"`);
            replyContent = faqMatch.answer;
            audioUrl = faqMatch.audioUrl; // We get the audio URL immediately!
            source = "FAQ_DB";
        }
    } catch (err) {
        console.warn("⚠️ FAQ Check Failed (continuing to AI):", err.message);
    }

    // --- 🤖 STEP B: Call Groq AI (Only if no FAQ found) ---
    if (!replyContent) {
        console.log("🤖 FAQ MISS: Calling Groq AI...");
        let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (chatHistory && Array.isArray(chatHistory)) {
            groqMessages = [...groqMessages, ...chatHistory];
        }
        groqMessages.push({ role: "user", content: message });
        
        const replyString = await getAIChatResponse(groqMessages);

        try {
            const jsonReply = JSON.parse(replyString);
            replyContent = jsonReply.content || jsonReply.text || replyString;
        } catch (e) {
            replyContent = replyString;
        }
    }

    // Save Chat History
    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    // Return Data
    res.status(200).json({ 
        success: true, 
        reply: { type: 'text', content: replyContent },
        audioUrl: audioUrl, // Frontend can play this directly!
        source: source
    });
});

// ============================================================
// 🔹 2. Handle Speak (Cached ElevenLabs Voice)
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    
    if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });

    // Normalize and Hash
    const normalizedText = text.trim().toLowerCase();
    const textHash = crypto.createHash('sha256').update(normalizedText).digest('hex');

    try {
        // --- Check Database Cache ---
        const cachedVoice = await db.VoiceResponse.findOne({ where: { textHash } });

        if (cachedVoice) {
            console.log("✅ VOICE CACHE HIT: Serving from DB");
            return res.json({ success: true, audioUrl: cachedVoice.audioUrl, source: "cache" });
        }

        console.log("⚠️ VOICE CACHE MISS: Calling ElevenLabs...");

        // --- Call ElevenLabs ---
        const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_KEY;
        if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY missing.' });

        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/IvLWq57RKibBrqZGpQrC`, // Leo Voice
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            data: {
                text: text.substring(0, 2500),
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.8 }
            },
            responseType: 'arraybuffer'
        });

        // --- Upload & Save ---
        const cloudinaryUrl = await uploadAudioToCloudinary(response.data, textHash);

        await db.VoiceResponse.create({
            textHash: textHash,
            originalText: text,
            audioUrl: cloudinaryUrl,
            voiceId: "IvLWq57RKibBrqZGpQrC"
        });

        res.json({ success: true, audioUrl: cloudinaryUrl, source: "api" });

    } catch (error) {
        console.error('🔥 Voice Gen Error:', error.message);
        res.status(500).json({ error: 'Voice generation failed.' });
    }
});

// ============================================================
// 🔹 3. Admin: Add Smart Response (Saves to FAQ + Voice Cache)
// ============================================================
const addSmartResponse = asyncHandler(async (req, res) => {
    const { question, answer, audioUrl } = req.body;

    if (!question || !answer || !audioUrl) {
        return res.status(400).json({ success: false, message: "Question, Answer, and Audio URL are required." });
    }

    try {
        // 1. Save to FAQ Table (Stops Groq usage for this question)
        const newFaq = await db.FAQ.create({
            question: question.toLowerCase(),
            answer: answer,
            audioUrl: audioUrl
        });

        // 2. Save to VoiceResponse Table (Stops ElevenLabs usage for this answer)
        const textHash = crypto.createHash('sha256').update(answer.trim().toLowerCase()).digest('hex');
        
        const existingVoice = await db.VoiceResponse.findOne({ where: { textHash } });
        if (!existingVoice) {
            await db.VoiceResponse.create({
                textHash: textHash,
                originalText: answer,
                audioUrl: audioUrl,
                voiceId: "FAQ_PRESET"
            });
        }

        console.log(`✅ ADMIN: Smart Response added for "${question}"`);
        res.status(201).json({ success: true, message: "Smart Response saved! Costs = ZERO.", data: newFaq });

    } catch (error) {
        console.error("🔥 Admin FAQ Error:", error);
        res.status(500).json({ success: false, message: "Failed to save smart response." });
    }
});

const getAllChats = asyncHandler(async (req, res) => { 
    res.status(200).json({ success: true, message: "Chat history route" });
});

module.exports = { handleChat, handleSpeak, getAllChats, addSmartResponse };