/**
 * @file services/aiService.js
 * @description Titan ASI Engine (V44: Precision RAG + Semantic Ranking + Weight Matching)
 * @status PRODUCTION READY
 */

const Groq = require("groq-sdk");
const NodeCache = require("node-cache");
const axios = require('axios');
const { uploadAudioToCloudinary } = require('./cloudinaryService');

// DB connection
const db = require('../models'); 

const { GET_ASI_PROMPT } = require('../utils/prompts'); 
const crypto = require('crypto');
const path = require('path');
const { Op } = require('sequelize'); 

// Env Config
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Cache Setup
const aiCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); 

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

// Models
const TEXT_MODEL = 'llama-3.3-70b-versatile';
const VISION_MODEL = 'llama-3.2-11b-vision-preview';

// --- HELPER: Sentence Finisher ---
function cleanIncompleteSentence(text) {
    if (!text) return "";
    let clean = text.trim();
    if (!clean.endsWith('.') && !clean.endsWith('!') && !clean.endsWith('?') && !clean.endsWith('|') && !clean.endsWith('।')) {
        return clean + "..."; 
    }
    return clean;
}

// ============================================================
// 🔍 RAG SYSTEM: SUPER EXPERT RANKING (V44)
// ============================================================
async function fetchLiveContext(query) {
    if (!query) return "";
    
    try {
        // 1. Advanced Tokenization
        // Extract "25g", "500ml", "1kg" specifically for weight matching
        const weightRegex = /(\d+\s*[g|kg|ml|l|gm]+)/gi;
        const weights = query.match(weightRegex) || [];
        
        // Clean query for text search
        const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
        const stopWords = [
            'what', 'is', 'price', 'rate', 'batao', 'kya', 'hai', 'tell', 'me', 'about', 
            'kaisa', 'cost', 'kitna', 'details', 'show', 'product', 'ka', 'ki', 'ke', 'ko', 'mein', 'he', 'this', 'that', 'it', 'for', 'of'
        ];
        
        const keywords = cleanQuery.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

        if (keywords.length === 0) return "";
        if (!db || !db.Product) return "";

        // 2. BROAD FETCH (Get Candidate Pool)
        // Fetch broad matches first, filter logic comes later in JS (Faster for <10k items)
        const products = await db.Product.findAll({
            where: {
                [Op.or]: [
                    ...keywords.map(k => ({ name: { [Op.like]: `%${k}%` } })),
                    ...keywords.map(k => ({ category: { [Op.like]: `%${k}%` } })),
                    ...keywords.map(k => ({ aiTags: { [Op.like]: `%${k}%` } }))
                ]
            },
            limit: 15, // Get a pool of 15 candidates
            attributes: [
                'name', 'mrp', 'dp', 'pv', 'category', 
                'description', 'ingredients', 'healthBenefits', 'usageInfo'
            ],
            raw: true 
        });

        if (products.length === 0) return "";

        // 3. 🧠 SEMANTIC RANKING ALGORITHM
        const rankedProducts = products.map(p => {
            let score = 0;
            const pName = p.name.toLowerCase();
            const pCat = (p.category || "").toLowerCase();
            const pTags = JSON.stringify(p.aiTags || []).toLowerCase();

            // A. Exact Name Keyword Match (High Weight)
            keywords.forEach(k => {
                if (pName.includes(k)) score += 40;        
                else if (pTags.includes(k)) score += 20;   
                else if (pCat.includes(k)) score += 10;    
            });

            // B. Exact Weight Match (Critical for variants like 25g vs 50g)
            weights.forEach(w => {
                const cleanW = w.replace(/\s+/g, '').toLowerCase(); // "25 g" -> "25g"
                const cleanPName = pName.replace(/\s+/g, '');
                if (cleanPName.includes(cleanW)) score += 50; // Huge Boost for correct size
            });

            // C. Precise Phrase Bonus
            if (pName.startsWith(keywords[0])) score += 15; // Starts with search term

            return { product: p, score };
        });

        // 4. SORT & PICK TOP 3
        rankedProducts.sort((a, b) => b.score - a.score);
        const topProducts = rankedProducts.slice(0, 3).map(rp => rp.product);

        // 5. FORMATTING FOR AI (Explicit Context)
        return topProducts.map((p, index) => {
            const isBestMatch = index === 0 ? "🔥🔥 [BEST MATCH]" : "[RELATED]";
            
            // Helper: Clean Arrays/JSON strings
            const parseList = (val) => {
                if (!val) return "Not listed";
                if (Array.isArray(val)) return val.join(", ");
                try {
                    const parsed = JSON.parse(val);
                    return Array.isArray(parsed) ? parsed.join(", ") : val;
                } catch (e) { return val; }
            };

            // Helper: Clean Usage
            const parseUsage = (val) => {
                if (!val) return "Check packaging";
                try {
                    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
                    return parsed.raw || "Check packaging";
                } catch (e) { return val; }
            };

            // Clean Description
            let desc = p.description ? p.description.substring(0, 500).replace(/\n/g, " ") : "N/A";
            if (desc === p.name) desc = "No additional details available.";

            return `${isBestMatch}
📦 PRODUCT: ${p.name}
📂 CATEGORY: ${p.category}
💰 PRICING: MRP ₹${p.mrp} | DP ₹${p.dp} | PV ${p.pv}
📝 ABOUT: ${desc}
🥗 INGREDIENTS: ${parseList(p.ingredients)}
💪 BENEFITS: ${parseList(p.healthBenefits)}
⚙️ USAGE: ${parseUsage(p.usageInfo)}
`;
        }).join("\n===================================\n");

    } catch (error) {
        console.error("⚠️ Expert Context Error:", error.message);
        return "";
    }
}

// ============================================================
// 🧠 TEXT GENERATION (TITAN ASI)
// ============================================================
async function generateTitanResponse(user, message, history = []) {
    if (!groqClient) return "System maintenance par hai. Jai RCM.";
    
    try {
        // 1. Fetch relevant product data (Using V44 Ranking)
        const liveData = await fetchLiveContext(message);

        // 2. Generate System Prompt
        const systemPrompt = GET_ASI_PROMPT({
            userName: user?.fullName || "Leader",
            userPin: user?.pinLevel || "Associate Buyer",
            liveData: liveData 
        });

        // 3. Message Chain
        const conversationChain = [
            { role: "system", content: systemPrompt },
            ...history, 
            { role: "user", content: message }
        ];

        const completion = await groqClient.chat.completions.create({
            model: TEXT_MODEL,
            messages: conversationChain, 
            // 🛑 STRICT TEMPERATURE: Keeps answers factual based on liveData
            temperature: 0.3, 
            max_tokens: 800,
            top_p: 0.85,
        });

        let aiResponse = completion.choices[0]?.message?.content || "";
        return cleanIncompleteSentence(aiResponse);

    } catch (error) {
        console.error("🔥 Titan Engine Error:", error.status || error.message);
        return "Network weak hai. Kripya dobara message karein.";
    }
}

// ============================================================
// 👁️ VISION ANALYSIS (UNCHANGED)
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
                        { 
                            type: "text", 
                            text: "You are an RCM Product Data Scanner. Your task is to extract EXACT text from the image.\n" +
                                  "1. IDENTIFY: Product Name, Net Quantity/Weight.\n" +
                                  "2. EXTRACT NUMBERS: Look specifically for 'MRP', 'PV', 'DP' or 'Rate'. Quote exactly what is printed.\n" +
                                  "3. DISCLAIMER: If the text is blurry or invisible, strictly say 'Details clear nahi hain'. Do NOT guess or hallucinate numbers.\n" +
                                  "4. LANGUAGE: Hindi/Hinglish summary." 
                        },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageContent}` } }
                    ],
                },
            ],
            model: VISION_MODEL,
            temperature: 0.2, 
            max_tokens: 400,
        });

        return cleanIncompleteSentence(chatCompletion.choices[0]?.message?.content || "Main is chitra ko samajh nahi paa raha.");
    } catch (error) {
        console.error("⚠️ Vision Error:", error.message);
        return "Photo scan nahi ho payi. Kripya dobara bhejein.";
    }
}

// ============================================================
// 🎙️ VOICE GENERATION (UNCHANGED)
// ============================================================
async function getOrGenerateVoice(text) {
    if (!text) return null;
    
    try {
        const cleanText = text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '').trim();
        const textHash = crypto.createHash('sha256').update(cleanText).digest('hex');

        if (db && db.VoiceResponse) {
            const cachedVoice = await db.VoiceResponse.findOne({ where: { textHash } });
            if (cachedVoice) return cachedVoice.audioUrl;
        }

        const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
        if (!ELEVENLABS_API_KEY) return null;

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
        
        if (db && db.VoiceResponse) {
            db.VoiceResponse.create({ 
                textHash, originalText: text, audioUrl: cloudinaryUrl, voiceId: "ELEVEN_LABS_AUTO" 
            }).catch(err => console.error("DB Save Error:", err.message));
        }
        
        return cloudinaryUrl;

    } catch (error) {
        return null;
    }
}

module.exports = { 
    generateTitanResponse, 
    analyzeImageWithAI,     
    getOrGenerateVoice      
};