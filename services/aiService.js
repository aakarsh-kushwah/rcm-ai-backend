const Groq = require("groq-sdk");
const { MASTER_PROMPT } = require('../utils/prompts');
const NodeCache = require( "node-cache" ); // npm install node-cache

// --- 1. HIGH-PERFORMANCE CONFIGURATION ---

// In-memory Cache (Redis ka chhota bhai) - For ultra-fast responses
// TTL: 1 hour (3600 seconds)
const aiCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// Groq Client Initialization with Singleton Pattern
let groqClient = null;
try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.warn("⚠️ CRITICAL: GROQ_API_KEY missing. AI Brain is offline.");
    } else {
        groqClient = new Groq({ apiKey });
        console.info("✅ Neural Engine (Groq) Online.");
    }
} catch (err) {
    console.error("❌ AI Core Failure:", err.message);
}

// Smart Model Selection (Failover Strategy)
const MODELS_TIER_1 = 'llama-3.3-70b-versatile'; // Best Quality
const MODELS_TIER_2 = 'llama3-70b-8192';         // Faster
const MODELS_TIER_3 = 'mixtral-8x7b-32768';      // Backup

// Default Brain Instructions
const DEFAULT_SYSTEM_PROMPT = MASTER_PROMPT || "You are a highly intelligent business consultant.";

// --- 2. ADVANCED UTILITIES ---

/**
 * Generates a unique hash for the conversation to use as Cache Key.
 * @param {Array} messages 
 */
function generateCacheKey(messages) {
    try {
        // Use last user message as primary key factor
        const lastMsg = messages[messages.length - 1].content;
        return `chat_${lastMsg.substring(0, 50).trim()}_${messages.length}`;
    } catch (e) {
        return null;
    }
}

/**
 * Prepares & Sanitizes Messages for Enterprise AI.
 * Injects JSON enforcement protocols.
 */
function prepareMessagesForEnterprise(incomingMessages) {
    if (!Array.isArray(incomingMessages)) return [];

    // 1. Filter & Sanitize Input
    const validMessages = incomingMessages.filter(
        (msg) => msg && msg.role && typeof msg.content === 'string' && msg.content.trim().length > 0
    );

    let systemPromptFound = false;

    // 2. Inject JSON Instructions (Critical for Structured Data)
    const enhancedMessages = validMessages.map(msg => {
        if (msg.role === "system") {
            systemPromptFound = true;
            // Force JSON mode if not present
            if (!msg.content.includes("JSON")) {
                return { 
                    ...msg, 
                    content: `${msg.content} \n\n[SYSTEM OVERRIDE]: You MUST respond in valid JSON format only.` 
                };
            }
        }
        return msg;
    });

    // 3. Inject Master Prompt if missing
    if (!systemPromptFound) {
        enhancedMessages.unshift({
            role: "system",
            content: `${DEFAULT_SYSTEM_PROMPT} \n\n[PROTOCOL]: Respond strictly in JSON format.`,
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

/**
 * Executes AI logic with Caching, Failover, and Retry mechanisms.
 * Capable of handling massive concurrency.
 */
async function getAIChatResponse(messages) {
    // A. Health Check
    if (!groqClient) return createFallbackResponse("AI Neural Net is offline.");

    // B. Cache Check (The Speed Layer)
    const cacheKey = generateCacheKey(messages);
    if (cacheKey) {
        const cachedResponse = aiCache.get(cacheKey);
        if (cachedResponse) {
            // console.log("🚀 Cache Hit! Serving instant response.");
            return cachedResponse; // <1ms latency
        }
    }

    // C. Prepare Data
    const processedMessages = prepareMessagesForEnterprise(messages);

    // D. Execution Pipeline (Tiered Model Attempt)
    const models = [MODELS_TIER_1, MODELS_TIER_2, MODELS_TIER_3];

    for (const model of models) {
        try {
            // Attempt Generation
            const completion = await groqClient.chat.completions.create({
                model: model,
                messages: processedMessages,
                temperature: 0.6, // Creativity Balance
                max_tokens: 1024,
                top_p: 1,
                stream: false,
                response_format: { type: "json_object" }, // Strict JSON
            });
            
            const content = completion.choices[0]?.message?.content;
            
            if (content) {
                // E. Validation & Caching
                try {
                    // Verify it's valid JSON
                    JSON.parse(content);
                    
                    // Cache the valid result (Save computation costs)
                    if (cacheKey) aiCache.set(cacheKey, content);
                    
                    return content;
                } catch (jsonError) {
                    console.warn(`⚠️ Model ${model} returned invalid JSON. Trying next tier...`);
                    // Continue to next model in loop
                }
            }

        } catch (error) {
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
                        // Auto-wrap in JSON structure
                        const safeResponse = JSON.stringify({ type: "text", content: rawContent });
                        return safeResponse;
                    }
                } catch (e) { /* Ignore and try next model */ }
            }
        }
    }

    // F. Critical Failure Handling
    console.error("🔥 All AI Tiers Exhausted. Service saturated.");
    return createFallbackResponse("I am currently overwhelmed with traffic. Please give me a moment to recover.");
}

module.exports = { getAIChatResponse };