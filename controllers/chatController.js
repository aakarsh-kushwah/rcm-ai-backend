const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');
const crypto = require('crypto');
const stringSimilarity = require("string-similarity");

// --- 🧠 Helper: Clean Input (Text को साफ करता है) ---
function cleanInput(text) {
    if (!text) return "";
    return text.toLowerCase()
        .replace(/[^\w\s]/gi, '') // सिम्बल्स (?, !, .) हटाता है
        .replace(/\s+/g, ' ')     // एक्स्ट्रा स्पेस हटाता है
        .trim();
}

// --- 🧠 Helper: Smart Hinglish Tag Generator ---
// यह फंक्शन एक सवाल से 10-12 अलग-अलग तरीके के सवाल बना देता है
function generateVariations(sentence) {
    // 1. Core Topic निकालें (जैसे "What is RCM" से "RCM")
    const stopWords = ['what', 'is', 'the', 'a', 'an', 'explain', 'tell', 'me', 'about', 'kya', 'he', 'hai', 'h', 'ka', 'ki', 'ke', '?'];
    const words = cleanInput(sentence).split(' ');
    const topicWords = words.filter(w => !stopWords.includes(w));
    const topic = topicWords.join(' '); // e.g., "rcm" or "body lotion"

    if (!topic) return [cleanInput(sentence)];

    // 2. Variations (Tags) बनाएं
    return [
        cleanInput(sentence),        // Original: "what is rcm"
        topic,                       // Raw: "rcm"
        
        // English Variations
        `explain ${topic}`,
        `define ${topic}`,
        `${topic} details`,
        `about ${topic}`,
        `benefits of ${topic}`,
        
        // Hinglish Variations (ये सबसे जरूरी है)
        `${topic} kya hai`,
        `${topic} kya he`,
        `${topic} kya h`,
        `${topic} ke fayde`,
        `${topic} ki jankari`,
        `${topic} kaise kare`,
        `${topic} kyu kare`,
        `${topic} details batao`,
        `${topic} ka matlab`
    ];
}

// ============================================================
// 🔹 1. Handle User Chat (SMART TAG SEARCH)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) return res.status(400).json({ success: false, message: "Message required" });

    let replyContent = "";
    let audioUrl = null;
    let source = "AI";

    // 1. यूजर के मैसेज को साफ करें
    const userMsgClean = cleanInput(message);
    console.log(`🔍 User Input: "${userMsgClean}"`);

    // --- 🕵️ STEP A: Smart DB Search ---
    try {
        // सारे FAQs लाओ
        const allFaqs = await db.FAQ.findAll({
            attributes: ['id', 'question', 'answer', 'audioUrl', 'tags']
        });

        let bestMatch = { rating: 0, faq: null };

        // हर FAQ के Tags में ढूंढो
        allFaqs.forEach(faq => {
            // हम मुख्य सवाल और उसके सारे Tags में मैच करेंगे
            const candidates = [cleanInput(faq.question), ...(faq.tags || [])];
            
            // Fuzzy Match ढूंढो
            const match = stringSimilarity.findBestMatch(userMsgClean, candidates);
            
            if (match.bestMatch.rating > bestMatch.rating) {
                bestMatch = { rating: match.bestMatch.rating, faq: faq };
            }
        });

        console.log(`📊 Best Match Score: ${(bestMatch.rating * 100).toFixed(0)}%`);

        // ✅ अगर 45% से ज्यादा मैच हो, तो सही जवाब दे दो
        if (bestMatch.rating > 0.45) {
            console.log(`✅ DATABASE HIT: Found answer for "${userMsgClean}"`);
            replyContent = bestMatch.faq.answer;
            audioUrl = bestMatch.faq.audioUrl;
            source = "FAQ_DB";
        }

    } catch (err) {
        console.warn("⚠️ Database Search Error:", err.message);
    }

    // --- 🤖 STEP B: Call Groq AI (अगर DB में कुछ नहीं मिला) ---
    if (!replyContent) {
        console.log("🤖 DB Miss -> Calling Groq AI...");
        let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (chatHistory) groqMessages = [...groqMessages, ...chatHistory];
        groqMessages.push({ role: "user", content: message });
        
        const replyString = await getAIChatResponse(groqMessages);

        try {
            const jsonReply = JSON.parse(replyString);
            replyContent = jsonReply.content || jsonReply.text || replyString;
        } catch (e) {
            replyContent = replyString;
        }
    }

    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    res.status(200).json({ 
        success: true, 
        reply: { type: 'text', content: replyContent },
        audioUrl: audioUrl, 
        source: source
    });
});

// ============================================================
// 🔹 2. Handle Speak
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text required' });

    const normalizedText = cleanInput(text); 
    const textHash = crypto.createHash('sha256').update(normalizedText).digest('hex');

    try {
        const cachedVoice = await db.VoiceResponse.findOne({ where: { textHash } });
        if (cachedVoice) return res.json({ success: true, audioUrl: cachedVoice.audioUrl, source: "cache" });

        const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
        if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'API Key missing.' });

        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/IvLWq57RKibBrqZGpQrC`, 
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            data: {
                text: text.substring(0, 2500),
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.8 }
            },
            responseType: 'arraybuffer'
        });

        const cloudinaryUrl = await uploadAudioToCloudinary(response.data, textHash);

        await db.VoiceResponse.create({
            textHash: textHash, originalText: text, audioUrl: cloudinaryUrl, voiceId: "IvLWq57RKibBrqZGpQrC"
        });

        res.json({ success: true, audioUrl: cloudinaryUrl, source: "api" });
    } catch (error) {
        console.error('🔥 Voice Error:', error.message);
        res.status(500).json({ error: 'Voice generation failed.' });
    }
});

// ============================================================
// 🔹 3. Admin: Add Smart Response (AUTO TAG GENERATION)
// ============================================================
const addSmartResponse = asyncHandler(async (req, res) => {
    const { question, answer, audioUrl } = req.body;

    if (!question || !answer || !audioUrl) {
        return res.status(400).json({ success: false, message: "Missing fields." });
    }

    try {
        // ✅ यहाँ जादू हो रहा है: एक सवाल से 10-15 Tags बन रहे हैं
        const variations = generateVariations(question);
        console.log(`🧠 Generated Tags for "${question}":`, variations);
        
        const newFaq = await db.FAQ.create({
            question: cleanInput(question), 
            tags: variations, // यह सारे variations DB में save होंगे
            answer: answer,
            audioUrl: audioUrl
        });

        // Voice DB Sync
        const textHash = crypto.createHash('sha256').update(cleanInput(answer)).digest('hex');
        const existingVoice = await db.VoiceResponse.findOne({ where: { textHash } });
        if (!existingVoice) {
            await db.VoiceResponse.create({
                textHash: textHash, originalText: answer, audioUrl: audioUrl, voiceId: "FAQ_PRESET"
            });
        }

        res.status(201).json({ 
            success: true, 
            message: "Smart Response Saved with Hinglish Tags!", 
            tags: variations,
            data: newFaq 
        });

    } catch (error) {
        console.error("🔥 Admin FAQ Error:", error);
        res.status(500).json({ success: false, message: "Failed to save." });
    }
});

const getAllChats = asyncHandler(async (req, res) => { 
    res.status(200).json({ success: true, message: "Chat history route" });
});

module.exports = { handleChat, handleSpeak, getAllChats, addSmartResponse };