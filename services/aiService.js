const Groq = require("groq-sdk");
const { MASTER_PROMPT: DEFAULT_SYSTEM_PROMPT } = require('../utils/prompts');
const NodeCache = require("node-cache"); 
require('dotenv').config(); // ✅ Ensure env vars are loaded

// --- 1. CONFIGURATION & DEBUGGING ---

// In-memory Cache (Redis ka chhota bhai) - TTL: 1 hour
const aiCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

let groqClient = null;

// 🔍 DEBUG & FIX API KEY
try {
    let rawKey = process.env.GROQ_API_KEY;
    
    if (!rawKey) {
        console.warn("⚠️ CRITICAL: GROQ_API_KEY missing in .env file.");
    } else {
        // ✅ AUTO-FIX: Remove quotes if they exist (Common cause of 401)
        const apiKey = rawKey.replace(/['"]+/g, '').trim();
        
        // Log first 4 chars to verify (Safe)
        console.log(`✅ Neural Engine Online. Key: ${apiKey.substring(0, 4)}...`);
        
        groqClient = new Groq({ apiKey });
    }
} catch (err) {
    console.error("❌ AI Core Initialization Failed:", err.message);
}

// Smart Model Selection (Failover Strategy)
const MODELS_TIER_1 = 'llama-3.3-70b-versatile'; // Best Quality
const MODELS_TIER_2 = 'llama3-70b-8192';         // Faster
const MODELS_TIER_3 = 'mixtral-8x7b-32768';      // Backup

/**
 * Generates a unique hash for the conversation to use as Cache Key.
 */
function generateCacheKey(messages) {
    try {
        const lastMsg = messages[messages.length - 1].content;
        return `chat_${lastMsg.substring(0, 50).trim()}_${messages.length}`;
    } catch (e) {
        return null;
    }
}

/**
 * Prepares & Sanitizes Messages.
 * ✅ INJECTS HINGLISH PROTOCOL HERE
 */
function prepareMessagesForEnterprise(incomingMessages) {
    if (!Array.isArray(incomingMessages)) return [];

    const validMessages = incomingMessages.filter(
        (msg) => msg && msg.role && typeof msg.content === 'string' && msg.content.trim().length > 0
    );

    let systemPromptFound = false;

    // Inject Instructions
    const enhancedMessages = validMessages.map(msg => {
        if (msg.role === "system") {
            systemPromptFound = true;
            
            // 🔹 HINGLISH INSTRUCTION INJECTED HERE
            const hinglishInstruction = `
            \n[LANGUAGE PROTOCOL]: 
            - You MUST respond in **Hinglish** (Conversational Hindi written in English script).
            - Mix English words for technical terms (like 'Business Plan', 'Profit', 'Direct Selling').
            - Tone: Friendly, professional, and encouraging.
            - Example: "RCM ka business plan bahut simple hai. Aapko bas apne daily use ke products replace karne hain."
            `;

            return { 
                ...msg, 
                content: `${msg.content} ${hinglishInstruction} \n\n[SYSTEM OVERRIDE]: You MUST respond in valid JSON format only.` 
            };
        }
        return msg;
    });

    // Inject Master Prompt if missing
    if (!systemPromptFound) {
        enhancedMessages.unshift({
            role: "system",
            content: `${DEFAULT_SYSTEM_PROMPT || "You are a helpful assistant."} \n[LANGUAGE PROTOCOL]: Respond in Hinglish. \n[PROTOCOL]: Respond strictly in JSON format.`,
        });
    }
    
    return enhancedMessages;
}

function createFallbackResponse(message) {
    return JSON.stringify({
        type: "text",
        content: message,
        meta: { source: "fallback_system", latency: 0 }
    });
}

// --- 3. THE AI ORCHESTRATOR SERVICE ---

async function getAIChatResponse(messages) {
    // A. Health Check
    if (!groqClient) return createFallbackResponse("AI Neural Net is offline (Check API Key).");

    // B. Cache Check
    const cacheKey = generateCacheKey(messages);
    if (cacheKey) {
        const cachedResponse = aiCache.get(cacheKey);
        if (cachedResponse) return cachedResponse;
    }

    // C. Prepare Data
    const processedMessages = prepareMessagesForEnterprise(messages);
    const models = [MODELS_TIER_1, MODELS_TIER_2, MODELS_TIER_3];

    // D. Execution Pipeline
    for (const model of models) {
        try {
            const completion = await groqClient.chat.completions.create({
                model: model,
                messages: processedMessages,
                temperature: 0.6,
                max_tokens: 1024,
                top_p: 1,
                stream: false,
                response_format: { type: "json_object" },
            });
            
            const content = completion.choices[0]?.message?.content;
            
            if (content) {
                // E. Validation & Caching
                try {
                    JSON.parse(content);
                    if (cacheKey) aiCache.set(cacheKey, content);
                    return content;
                } catch (jsonError) {
                    console.warn(`⚠️ Model ${model} returned invalid JSON. Trying next tier...`);
                }
            }

        } catch (error) {
            // SPECIFIC AUTH ERROR HANDLING
            if (error.status === 401 || (error.error && error.error.code === 'invalid_api_key')) {
                console.error("❌ FATAL: Invalid API Key. Please check .env file.");
                return createFallbackResponse("System Error: API Key is invalid.");
            }

            console.warn(`⚠️ AI Model Glitch (${model}):`, error.message);
            
            // Smart Fallback: If JSON mode failed, try RAW TEXT mode
            if (error.message.includes("json")) {
                try {
                    const rawCompletion = await groqClient.chat.completions.create({
                        model: model,
                        messages: processedMessages,
                        temperature: 0.5,
                    });
                    const rawContent = rawCompletion.choices[0]?.message?.content;
                    if (rawContent) {
                        return JSON.stringify({ type: "text", content: rawContent });
                    }
                } catch (e) { /* Ignore */ }
            }
        }
    }

    // F. Critical Failure Handling
    console.error("🔥 All AI Tiers Exhausted.");
    return createFallbackResponse("Abhi system thoda busy hai, kripya kuch der baad try karein.");
}

module.exports = { getAIChatResponse };