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

const { GET_ASI_PROMPT, VISION_SCANNER_PROMPT } = require('../utils/prompts/masterPrompt'); 
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

// ============================================================
// 📚 RAG SYSTEM: BUSINESS KNOWLEDGE BASE & RULE-BASED LAYER
// ============================================================
function formatBusinessKnowledgeResponse(item, userName = "Leader") {
    if (!item) return null;

    const title = item.title || "RCM Business Rule";
    const content = item.content || "";

    return `${userName} ji, ${title} ki poori jaankari yeh hai:\n\n${content}`;
}

async function fetchBusinessKnowledge(query, options = {}) {
    if (!query) return { textContext: "", rawMatch: null, isSingleTopic: false };

    try {
        const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
        const stopWords = ['what', 'is', 'batao', 'kya', 'hai', 'tell', 'me', 'about', 'kitna', 'details', 'ka', 'ki', 'ke', 'ko', 'mein', 'this', 'that', 'for', 'of', 'bonus', 'rcm'];
        const keywords = cleanQuery.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

        if (!db || !db.BusinessKnowledge) return { textContext: "", rawMatch: null, isSingleTopic: false };

        let items = [];
        let fetchedByPrimaryCategory = false;
        let matchedCategoryKey = null;

        // Bonus category mapping
        const bonusCategoriesMap = {
            'royalty bonus': 'Royalty_Bonus',
            'royalty': 'Royalty_Bonus',
            'technical bonus': 'Technical_Bonus',
            'technical': 'Technical_Bonus',
            'performance bonus': 'Performance_Bonus',
            'performance': 'Performance_Bonus',
            'consistency bonus': 'Consistency_Bonus',
            'consistency': 'Consistency_Bonus',
            'vital level pin chart': 'Vital_Level_Pin_Chart',
            'vital level': 'Vital_Level_Pin_Chart',
            'pin chart': 'Vital_Level_Pin_Chart', // Prioritize 'vital' for this specific chart
            'pin level income chart': 'Pin_Level_Income_Chart',
            'pin level': 'Pin_Level_Income_Chart',
            'milestone chart': 'Pin_Level_Income_Chart',
            'growth bonus': 'Growth_Bonus',
            'vital growth bonus': 'Growth_Bonus',
            'royalty growth bonus': 'Growth_Bonus',
            'technical growth bonus': 'Growth_Bonus',
            'paint purchase bonus': 'Paint_Purchase_Bonus',
            'paint bonus': 'Paint_Purchase_Bonus',
            'paint': 'Paint_Purchase_Bonus',
            'pv bv rules': 'PV_BV_Rules',
            'policy faq': 'Policy_FAQ',
            'guidelines': 'Policy_FAQ'
        };
        for (const [phrase, categoryName] of Object.entries(bonusCategoriesMap)) {
            if (cleanQuery.includes(phrase)) {
                items = await db.BusinessKnowledge.findAll({
                    where: {
                        isActive: true,
                        category: categoryName
                    },
                    order: [['updatedAt', 'DESC']], // Fetch the latest updated record
                    limit: 1,
                    attributes: ['title', 'category', 'content'],
                    raw: true
                });
                if (items.length > 0) {
                    fetchedByPrimaryCategory = true;
                    matchedCategoryKey = categoryName;
                    break;
                }
            }
        }

        // Check if query is single-topic vs mixed
        const calculationKeywords = ['calc', 'calculate', 'banega', 'kaise', 'formula', 'difference', 'differential', 'group pv', 'self pv'];
        const isCalculation = calculationKeywords.some(k => cleanQuery.includes(k));
        
        // Count unique matched categories (e.g. Royalty vs Technical)
        const uniqueMatchedCategories = new Set(
            Object.entries(bonusCategoriesMap)
                .filter(([phrase]) => cleanQuery.includes(phrase))
                .map(([, category]) => category)
        );

        const isSingleTopic = fetchedByPrimaryCategory && uniqueMatchedCategories.size === 1 && !isCalculation;

        // Fallback search if no category match
        if (!fetchedByPrimaryCategory && keywords.length > 0) {
            const whereCondition = {
                isActive: true,
                [Op.or]: [
                    ...keywords.map(k => ({ title: { [Op.like]: `%${k}%` } })),
                    ...keywords.map(k => ({ keywords: { [Op.like]: `%${k}%` } })),
                    ...keywords.map(k => ({ category: { [Op.like]: `%${k}%` } }))
                ]
            };
            items = await db.BusinessKnowledge.findAll({
                where: whereCondition,
                limit: 2,
                attributes: ['title', 'category', 'content'],
                raw: true
            });
        }

        if (items.length === 0) {
            return { textContext: "", rawMatch: null, isSingleTopic: false };
        }

        const textContext = items.map(item => `📌 [BUSINESS RULE: ${item.title} (${item.category})]\n${item.content}`).join("\n\n");

        return {
            textContext,
            rawMatch: items[0],
            isSingleTopic
        };
    } catch (error) {
        console.error("⚠️ Business Knowledge Context Error:", error.message);
        return { textContext: "", rawMatch: null, isSingleTopic: false };
    }
}
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
        const userName = user?.fullName || "Leader";

        // 1. Fetch relevant product data (Using V44 Ranking) & Business Knowledge RAG
        const liveData = await fetchLiveContext(message);
        const ragResult = await fetchBusinessKnowledge(message);

        // RULE-BASED EXTRACTION LAYER:
        // Intercept single-topic queries with strong category matches directly without AI model intervention
        if (ragResult.isSingleTopic && ragResult.rawMatch) {
            console.log(`⚡ [RULE-BASED EXTRACTION] Intercepted single-topic query for category: ${ragResult.rawMatch.category}`);
            return formatBusinessKnowledgeResponse(ragResult.rawMatch, userName);
        }

        const businessKnowledgeData = ragResult.textContext || "";
        const combinedLiveData = [liveData, businessKnowledgeData].filter(Boolean).join("\n\n===================================\n\n");

        // 2. Generate System Prompt
        const systemPrompt = GET_ASI_PROMPT({
            userName: userName,
            userPin: user?.pinLevel || "Associate Buyer",
            liveData: combinedLiveData 
        });

        // 3. Message Chain
        const conversationChain = [
            { role: "system", content: systemPrompt },
            ...history, 
            { role: "user", content: message }
        ];

        let completion;
        let retries = 2;
        let delay = 1500;

        for (let attempt = 1; attempt <= retries + 1; attempt++) {
            try {
                completion = await groqClient.chat.completions.create({
                    model: TEXT_MODEL,
                    messages: conversationChain, 
                    // 🛑 STRICT TEMPERATURE: Keeps answers factual based on liveData
                    temperature: 0.3, 
                    max_tokens: 800,
                    top_p: 0.85,
                });
                break;
            } catch (err) {
                const isRateLimit = err.status === 429 || (err.message && err.message.includes('429')) || (err.message && err.message.includes('rate_limit'));
                if (isRateLimit && attempt <= retries) {
                    console.warn(`⚠️ Groq Rate Limit (429) hit. Retrying attempt ${attempt} in ${delay}ms...`);
                    await new Promise(res => setTimeout(res, delay));
                    delay *= 2; // exponential backoff
                    continue;
                }
                throw err;
            }
        }

        let aiResponse = completion.choices[0]?.message?.content || "";
        return cleanIncompleteSentence(aiResponse);

    } catch (error) {
        console.error("🔥 Titan Engine Error:", error.status || error.message);
        const isRateLimit = error.status === 429 || (error.message && error.message.includes('429')) || (error.message && error.message.includes('rate_limit'));
        if (isRateLimit) {
            return "Thoda busy hoon, ek pal rukiye. Dobara koshish kar rahe hain...";
        }
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
                            text: VISION_SCANNER_PROMPT 
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

const { sanitizeForTTS } = require('../utils/textSanitizer'); // ADDED

// ... (existing imports)

// ============================================================
// 🎙️ VOICE GENERATION (UNCHANGED)
// ============================================================
async function getOrGenerateVoice(text) {
    if (!text) return null;
    
    try {
        const cleanText = sanitizeForTTS(text); // UPDATED
        const textHash = crypto.createHash('sha256').update(cleanText.toLowerCase()).digest('hex');

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
    getOrGenerateVoice,
    fetchBusinessKnowledge
};