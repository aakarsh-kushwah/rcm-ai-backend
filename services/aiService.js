/**
 * @file src/services/aiService.js
 * @description Powerhouse of RCM Bot (Text, Vision & Voice).
 */

const Groq = require("groq-sdk");
const NodeCache = require("node-cache");
const axios = require('axios');
const { uploadAudioToCloudinary } = require('./cloudinaryService');
const { db } = require('../config/db');
const crypto = require('crypto');
const path = require('path');

// ✅ FIX 1: Explicitly tell dotenv where the .env file is (Root Folder)
// This fixes the "UNDEFINED" issue if the server is started from a different folder
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// 🔍 DEBUGGING: Print to console to prove it works
const key = process.env.GROQ_API_KEY;
console.log("DEBUG: Loaded Groq Key:", key ? `${key.substring(0, 5)}...[Length: ${key.length}]` : "UNDEFINED - CHECK .ENV FILE PATH");

// 🚀 Cache Setup
const aiCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// Initialize Groq Neural Engine
let groqClient = null;
try {
    if (key) {
        // ✅ FIX 2: Use the variable, do not hardcode!
        groqClient = new Groq({ apiKey: key.trim() });
        console.log(`✅ Neural Engine Online (Groq/Llama-3).`);
    } else {
        console.warn("⚠️ Groq API Key Missing! AI will not function.");
    }
} catch (err) { console.error("❌ AI Init Failed:", err.message); }

// 🧠 Model Config
const MODELS_TIER_1 = 'llama-3.3-70b-versatile';
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

// --- 📝 TEXT GENERATION ---
async function getAIChatResponse(messages) {
    if (!groqClient) return "System maintenance par hai. Kripya thodi der baad message karein.";
    
    try {
        const completion = await groqClient.chat.completions.create({
            model: MODELS_TIER_1,
            messages: messages, 
            temperature: 0.6,
            max_tokens: 450,
            top_p: 0.9,
        });

        let aiResponse = completion.choices[0]?.message?.content || "";
        return cleanIncompleteSentence(aiResponse);

    } catch (error) {
        console.error("🔥 AI Generation Error:", error.status || error.message);
        return "Network weak hai. Kripya dobara message karein.";
    }
}

// --- 👁️ VISION ANALYSIS ---
async function analyzeImageWithAI(base64Image) {
    if (!groqClient) return "Vision system abhi uplabdh nahi hai.";
    
    try {
        const imageContent = base64Image.includes('base64,') ? base64Image.split('base64,')[1] : base64Image;

        const chatCompletion = await groqClient.chat.completions.create({
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Analyze this image efficiently. If it is a person, welcome them warmly in Hindi/Hinglish. If it is an RCM product, identify it and describe 1 key benefit in Hinglish. Keep it under 2 sentences." },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageContent}` } }
                    ],
                },
            ],
            model: VISION_MODEL,
            temperature: 0.5,
            max_tokens: 150,
        });

        return cleanIncompleteSentence(chatCompletion.choices[0]?.message?.content || "Main is chitra ko samajh nahi paa raha.");
    } catch (error) {
        console.error("⚠️ Vision Error:", error.message);
        return "Photo scan nahi ho payi. Kripya dobara bhejein.";
    }
}

// --- 🎙️ VOICE GENERATION ---
async function getOrGenerateVoice(text) {
    if (!text) return null;
    
    try {
        const cleanText = text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '').trim();
        const textHash = crypto.createHash('sha256').update(cleanText).digest('hex');

        // Check Cache
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

module.exports = { getAIChatResponse, getOrGenerateVoice, analyzeImageWithAI };