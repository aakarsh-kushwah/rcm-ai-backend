/**
 * @file src/services/aiService.js
 * @description Titan ASI Engine: Text (RAG), Vision & Voice Powerhouse.
 */

const Groq = require("groq-sdk");
const NodeCache = require("node-cache");
const axios = require('axios');
const { uploadAudioToCloudinary } = require('./cloudinaryService');
const { db } = require('../config/db');
const { GET_ASI_PROMPT } = require('../utils/prompts'); // ASI Prompt Import
const crypto = require('crypto');
const path = require('path');
const { Op } = require('sequelize'); // DB Search ke liye

// ✅ FIX: Load .env explicitly
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// 🚀 Cache Setup
const aiCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 Min Cache

// Initialize Groq Neural Engine
let groqClient = null;
const key = process.env.GROQ_API_KEY;

try {
    if (key) {
        groqClient = new Groq({ apiKey: key.trim() });
        console.log(`✅ Titan Neural Engine (Groq/Llama-3) Online.`);
    } else {
        console.warn("⚠️ Groq API Key Missing! AI will not function.");
    }
} catch (err) { console.error("❌ AI Init Failed:", err.message); }

// 🧠 Model Config
const TEXT_MODEL = 'llama-3.3-70b-versatile';
const VISION_MODEL = 'llama-3.2-11b-vision-preview';

// --- 🛠️ HELPER: Sentence Finisher ---
function cleanIncompleteSentence(text) {
    if (!text) return "";
    let clean = text.trim();
    if (!clean.endsWith('.') && !clean.endsWith('!') && !clean.endsWith('?') && !clean.endsWith('|') && !clean.endsWith('।')) {
        return clean + "..."; 
    }
    return clean;
}

// ============================================================
// 🔍 RAG SYSTEM: FETCH LIVE DATA (The "Magic" Part)
// ============================================================
async function fetchLiveContext(query) {
    if (!query) return "";
    
    try {
        // 1. Simple Keyword Extraction (Length > 3 characters)
        const keywords = query.split(' ').filter(w => w.length > 3);
        if (keywords.length === 0) return "";

        // 2. DB Search (Check if Product table exists)
        if (!db.Product) {
            console.warn("⚠️ Product table not defined in DB config.");
            return "";
        }

        // 3. Search Database for matching products
        const products = await db.Product.findAll({
            where: {
                [Op.or]: keywords.map(k => ({ 
                    name: { [Op.like]: `%${k}%` } // Matches partial names
                }))
            },
            limit: 3, // Only fetch top 3 to save context window
            attributes: ['name', 'dp', 'pv', 'mrp', 'description']
        });

        // 4. Format Data for AI
        if (products.length > 0) {
            return products.map(p => 
                `PRODUCT MATCH: ${p.name} | MRP: ₹${p.mrp} | DP (Rate): ₹${p.dp} | PV: ${p.pv} | Desc: ${p.description}`
            ).join('\n');
        }
        return "";

    } catch (error) {
        // Silent fail taaki chat na ruke
        console.error("⚠️ DB Context Fetch Failed:", error.message);
        return "";
    }
}

// ============================================================
// 🧠 TEXT GENERATION (TITAN ASI)
// ============================================================
async function generateTitanResponse(user, message) {
    if (!groqClient) return "System maintenance par hai. Jai RCM.";
    
    try {
        // Step 1: Live Data Fetch (RAG)
        const liveData = await fetchLiveContext(message);

        // Step 2: Prompt Construction (Injecting User Info & Live Data)
        const systemPrompt = GET_ASI_PROMPT({
            userName: user?.fullName || "Leader",
            userPin: user?.pinLevel || "Associate Buyer",
            liveData: liveData // <-- Yeh hai asli magic
        });

        // Step 3: AI Call
        const completion = await groqClient.chat.completions.create({
            model: TEXT_MODEL,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ], 
            temperature: 0.6,
            max_tokens: 600,
            top_p: 0.9,
        });

        let aiResponse = completion.choices[0]?.message?.content || "";
        return cleanIncompleteSentence(aiResponse);

    } catch (error) {
        console.error("🔥 Titan Engine Error:", error.status || error.message);
        return "Network weak hai. Kripya dobara message karein.";
    }
}

// ============================================================
// 👁️ VISION ANALYSIS
// ============================================================
async function analyzeImageWithAI(base64Image) {
    if (!groqClient) return "Vision system abhi uplabdh nahi hai.";
    
    try {
        const imageContent = base64Image.includes('base64,') ? base64Image.split('base64,')[1] : base64Image;

        const chatCompletion = await groqClient.chat.completions.create({
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "You are RCM Titan AI. Analyze this image. If it's a person, greet them with 'Jai RCM'. If it's a product, identify it and tell 1 key health benefit in Hindi/Hinglish." },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageContent}` } }
                    ],
                },
            ],
            model: VISION_MODEL,
            temperature: 0.5,
            max_tokens: 200,
        });

        return cleanIncompleteSentence(chatCompletion.choices[0]?.message?.content || "Main is chitra ko samajh nahi paa raha.");
    } catch (error) {
        console.error("⚠️ Vision Error:", error.message);
        return "Photo scan nahi ho payi. Kripya dobara bhejein.";
    }
}

// ============================================================
// 🎙️ VOICE GENERATION (ELEVENLABS)
// ============================================================
async function getOrGenerateVoice(text) {
    if (!text) return null;
    
    try {
        const cleanText = text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '').trim();
        const textHash = crypto.createHash('sha256').update(cleanText).digest('hex');

        // Check Cache (Database)
        const cachedVoice = await db.VoiceResponse.findOne({ where: { textHash } });
        if (cachedVoice) return cachedVoice.audioUrl;

        const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
        if (!ELEVENLABS_API_KEY) {
            console.warn("⚠️ ElevenLabs Key Missing.");
            return null;
        }

        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/IvLWq57RKibBrqZGpQrC?optimize_streaming_latency=3`,
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            data: {
                text: text.substring(0, 500),
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
            },
            responseType: 'arraybuffer'
        });

        const cloudinaryUrl = await uploadAudioToCloudinary(response.data, textHash);
        
        // Async save to DB
        db.VoiceResponse.create({ 
            textHash, originalText: text, audioUrl: cloudinaryUrl, voiceId: "ELEVEN_LABS_AUTO" 
        }).catch(err => console.error("DB Save Error:", err.message));
        
        return cloudinaryUrl;

    } catch (error) {
        if (error.response && [401, 402, 429].includes(error.response.status)) {
            console.warn(`⚠️ ElevenLabs Issue (${error.response.status}).`);
            return null;
        }
        console.error(`⚠️ Voice Gen Failed: ${error.message}`);
        return null;
    }
}

module.exports = { 
    generateTitanResponse, // New RAG Function
    analyzeImageWithAI,    // Vision
    getOrGenerateVoice     // Voice
};