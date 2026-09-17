/**
 * @file services/aiService.js
 * @description Titan ASI Engine (V44: Precision RAG + Semantic Ranking + Weight Matching + ImageUrl Support)
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

// Cache Setup (24 hours TTL)
const aiCache = new NodeCache({ stdTTL: 86400, checkperiod: 60 }); 

// Invalidation Helper
function invalidateProductCache(productId) {
    if (!productId) return;
    const targetId = parseInt(productId, 10);
    const keys = aiCache.keys();
    let count = 0;
    for (const key of keys) {
        const cached = aiCache.get(key);
        if (cached && Array.isArray(cached.referencedProductIds) && cached.referencedProductIds.includes(targetId)) {
            aiCache.del(key);
            count++;
            console.log(`🗑️ [AI CACHE] Invalidated cache key "${key}" for Product ID: ${targetId}`);
        }
    }
    return count;
}

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

// Models (Configurable via environment variables with fallback to Groq supported models)
const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';

let globalLastMatchedImageUrl = null;
const getLastMatchedImageUrl = () => globalLastMatchedImageUrl;

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
    if (!query) return { textContext: "", rawMatch: null, isSingleTopic: false, productIds: [] };

    try {
        const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
        const stopWords = ['what', 'is', 'batao', 'kya', 'hai', 'tell', 'me', 'about', 'kitna', 'details', 'ka', 'ki', 'ke', 'ko', 'mein', 'this', 'that', 'for', 'of', 'bonus', 'rcm'];
        const keywords = cleanQuery.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

        if (!db || !db.BusinessKnowledge) return { textContext: "", rawMatch: null, isSingleTopic: false, productIds: [] };

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
            'pin chart': 'Vital_Level_Pin_Chart',
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
                    order: [['updatedAt', 'DESC']],
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

        const calculationKeywords = ['calc', 'calculate', 'banega', 'kaise', 'formula', 'difference', 'differential', 'group pv', 'self pv'];
        const isCalculation = calculationKeywords.some(k => cleanQuery.includes(k));
        
        const uniqueMatchedCategories = new Set(
            Object.entries(bonusCategoriesMap)
                .filter(([phrase]) => cleanQuery.includes(phrase))
                .map(([, category]) => category)
        );

        const isSingleTopic = fetchedByPrimaryCategory && uniqueMatchedCategories.size === 1 && !isCalculation;

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
            return { textContext: "", rawMatch: null, isSingleTopic: false, productIds: [] };
        }

        const textContext = items.map(item => `📌 [BUSINESS RULE: ${item.title} (${item.category})]\n${item.content}`).join("\n\n");

        return {
            textContext,
            rawMatch: items[0],
            isSingleTopic,
            productIds: []
        };
    } catch (error) {
        console.error("⚠️ Business Knowledge Context Error:", error.message);
        return { textContext: "", rawMatch: null, isSingleTopic: false, productIds: [] };
    }
}

function cleanIncompleteSentence(text) {
    if (!text) return "";
    let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!clean.endsWith('.') && !clean.endsWith('!') && !clean.endsWith('?') && !clean.endsWith('|') && !clean.endsWith('।')) {
        return clean + "..."; 
    }
    return clean;
}

// ============================================================
// 🔍 RAG SYSTEM: SUPER EXPERT RANKING (V44)
// ============================================================
async function fetchLiveContext(query) {
    if (!query) return { textContext: "", productIds: [] };
    
    try {
        const weightRegex = /(\d+\s*[g|kg|ml|l|gm]+)/gi;
        const weights = query.match(weightRegex) || [];
        
        const cleanQuery = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
        const stopWords = [
            'what', 'is', 'price', 'rate', 'batao', 'kya', 'hai', 'tell', 'me', 'about',
            'kaisa', 'cost', 'kitna', 'details', 'show', 'product', 'ka', 'ki', 'ke', 'ko', 'mein', 'he', 'this', 'that', 'it', 'for', 'of',
            // Removed 'fayde' from stopWords list as it is a relevant keyword for health products.
        ];
        
        const keywords = cleanQuery.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

        if (keywords.length === 0) return { textContext: "", productIds: [] };
        if (!db || !db.Product) return { textContext: "", productIds: [] };

        const products = await db.Product.findAll({
            where: {
                [Op.and]: [
                    ...keywords.map(k => ({ // Each keyword must be present in at least one field
                        [Op.or]: [
                            { name: { [Op.like]: `%${k}%` } },
                            { category: { [Op.like]: `%${k}%` } },
                            { aiTags: { [Op.like]: `%${k}%` } },
                            { description: { [Op.like]: `%${k}%` } },
                            { healthBenefits: { [Op.like]: `%${k}%` } },
                            { usageInfo: { [Op.like]: `%${k}%` } }
                        ]
                    }))
                ]
            },
            limit: 15,
            attributes: [
                'id', 'name', 'mrp', 'dp', 'pv', 'category', 
                'description', 'ingredients', 'healthBenefits', 'usageInfo', 'imageUrl'
            ],
            raw: true 
        });

        if (products.length === 0) {
            globalLastMatchedImageUrl = null;
            return { textContext: "", productIds: [] };
        }

        const rankedProducts = products.map(p => {
            let score = 0;
            const pName = p.name.toLowerCase();
            const pCat = (p.category || "").toLowerCase();
            const pTags = JSON.stringify(p.aiTags || []).toLowerCase();

            keywords.forEach(k => {
                if (pName.includes(k)) score += 40;        
                else if (pTags.includes(k)) score += 20;   
                else if (pCat.includes(k)) score += 10;    
            });

            weights.forEach(w => {
                const cleanW = w.replace(/\s+/g, '').toLowerCase();
                const cleanPName = pName.replace(/\s+/g, '');
                if (cleanPName.includes(cleanW)) score += 50;
            });

            if (pName.startsWith(keywords[0])) score += 15;

            return { product: p, score };
        });

        rankedProducts.sort((a, b) => b.score - a.score);
        const topProducts = rankedProducts.slice(0, 3).map(rp => rp.product);
        globalLastMatchedImageUrl = topProducts[0]?.imageUrl || null;

        const productIds = topProducts.map(p => p.id);

        const textContext = topProducts.map((p, index) => {
            const isBestMatch = index === 0 ? "🔥🔥 [BEST MATCH]" : "[RELATED]";
            
            const parseList = (val) => {
                if (!val) return "Not listed";
                if (Array.isArray(val)) return val.join(", ");
                try {
                    const parsed = JSON.parse(val);
                    return Array.isArray(parsed) ? parsed.join(", ") : val;
                } catch (e) { return val; }
            };

            const parseUsage = (val) => {
                if (!val) return "Check packaging";
                try {
                    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
                    return parsed.raw || "Check packaging";
                } catch (e) { return val; }
            };

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

        return { textContext, productIds };

    } catch (error) {
        console.error("⚠️ Expert Context Error:", error.message);
        globalLastMatchedImageUrl = null;
        return { textContext: "", productIds: [] };
    }
}

// ============================================================
// 🧠 TEXT GENERATION (TITAN ASI)
// ============================================================
async function generateTitanResponse(user, message, history = []) {
    if (!groqClient) return { response: "System maintenance par hai. Jai RCM.", productIds: [] };

    const cacheKey = message.toLowerCase();
    const cachedResponse = aiCache.get(cacheKey);
    if (cachedResponse) {
        console.log(`✅ [AI CACHE] Cache Hit for query: "${message}"`);
        return cachedResponse;
    }
    
    try {
        const userName = user?.fullName || "Leader";

        const { textContext: liveData, productIds: liveProductIds } = await fetchLiveContext(message);
        const ragResult = await fetchBusinessKnowledge(message);

        if (ragResult.isSingleTopic && ragResult.rawMatch) {
            console.log(`⚡ [RULE-BASED EXTRACTION] Intercepted single-topic query for category: ${ragResult.rawMatch.category}`);
            globalLastMatchedImageUrl = null;
            const response = {
                response: formatBusinessKnowledgeResponse(ragResult.rawMatch, "{{userName}}"),
                productIds: ragResult.productIds || []
            };
            // Cache single-topic rule-based responses if they have content
            if (response.response && response.response.length > 0) {
                 aiCache.set(cacheKey, response);
                 console.log(`➕ [AI CACHE] Cached single-topic rule-based response for: "${message}"`);
            }
            return response;
        }

        const businessKnowledgeData = ragResult.textContext || "";
        const combinedLiveData = [liveData, businessKnowledgeData].filter(Boolean).join("\n\n===================================\n\n");
        const combinedProductIds = [...new Set([...liveProductIds, ...(ragResult.productIds || [])])];

        const systemPrompt = GET_ASI_PROMPT({
            userName: userName,
            userPin: user?.pinLevel || "Associate Buyer",
            liveData: combinedLiveData
        });

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
                    delay *= 2;
                    continue;
                }
                throw err;
            }
        }

        let aiResponse = completion.choices[0]?.message?.content || "";
        let finalResponse = cleanIncompleteSentence(aiResponse);

        // Replace actual userName with placeholder for cross-user caching
        if (userName && userName !== "Leader") {
            const escapedName = userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            finalResponse = finalResponse.replace(new RegExp(escapedName, 'gi'), '{{userName}}');
        }

        const responseToCache = { response: finalResponse, productIds: combinedProductIds, liveDataUsed: combinedLiveData };

        // Only cache responses that had real referencedProductIds (Issue 2 fix)
        // Or if it's a rule-based response with content, it would have been cached above
        if (combinedProductIds && combinedProductIds.length > 0) {
            aiCache.set(cacheKey, responseToCache);
            console.log(`➕ [AI CACHE] Cached response for: "${message}" with ${combinedProductIds.length} product(s)`);
        } else {
            console.log(`➖ [AI CACHE] Skipping cache for query: "${message}" (no products found)`);
        }

        return responseToCache;

    } catch (error) {
        console.error("🔥 Titan Engine Error:", error.status || error.message);
        const isRateLimit = error.status === 429 || (error.message && error.message.includes('429')) || (error.message && error.message.includes('rate_limit'));
        if (isRateLimit) {
            return { response: "Thoda busy hoon, ek pal rukiye. Dobara koshish kar rahe hain...", productIds: [], liveDataUsed: "" }; // Ensure liveDataUsed is always returned
        }
        return { response: "Network weak hai. Kripya dobara message karein.", productIds: [], liveDataUsed: "" }; // Ensure liveDataUsed is always returned
    }
}

// ============================================================
// 👁️ VISION ANALYSIS
// ============================================================
async function analyzeImageWithAI(base64Image) {
    if (!groqClient || !VISION_MODEL) return "Vision system abhi uplabdh nahi hai.";
    
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
            max_tokens: 600,
        });

        return cleanIncompleteSentence(chatCompletion.choices[0]?.message?.content || "Main is chitra ko samajh nahi paa raha.");
    } catch (error) {
        console.error("⚠️ Vision Error:", error.message);
        return "Photo scan nahi ho payi. Kripya dobara bhejein.";
    }
}

const { sanitizeForTTS } = require('../utils/textSanitizer');

// ============================================================
// 🎙️ VOICE GENERATION
// ============================================================
async function getOrGenerateVoice(text) {
    if (!text) return null;
    
    try {
        const cleanText = sanitizeForTTS(text);
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
    fetchBusinessKnowledge,
    getLastMatchedImageUrl,
    aiCache,
    invalidateProductCache
};
