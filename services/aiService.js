const Groq = require("groq-sdk");
const { MASTER_PROMPT: DEFAULT_SYSTEM_PROMPT } = require('../utils/prompts');
const NodeCache = require("node-cache"); 
require('dotenv').config();

// --- CONFIGURATION ---
const aiCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
let groqClient = null;

try {
    let rawKey = process.env.GROQ_API_KEY;
    if (!rawKey) {
        console.warn("⚠️ CRITICAL: GROQ_API_KEY missing in .env file.");
    } else {
        const apiKey = rawKey.replace(/['"]+/g, '').trim();
        groqClient = new Groq({ apiKey });
        console.log(`✅ Neural Engine Online.`);
    }
} catch (err) {
    console.error("❌ AI Core Initialization Failed:", err.message);
}

// ✅ Failover Models
const MODELS_TIER_1 = 'llama-3.3-70b-versatile'; 
const MODELS_TIER_2 = 'llama3-70b-8192';

// --- HELPER FUNCTIONS ---
function generateCacheKey(messages) {
    try {
        const lastMsg = messages[messages.length - 1].content;
        return `chat_${lastMsg.substring(0, 50).trim()}_${messages.length}`;
    } catch (e) { return null; }
}

function prepareMessagesForEnterprise(incomingMessages) {
    if (!Array.isArray(incomingMessages)) return [];

    const validMessages = incomingMessages.filter(
        (msg) => msg && msg.role && typeof msg.content === 'string' && msg.content.trim().length > 0
    );

    let systemPromptFound = false;
    const enhancedMessages = validMessages.map(msg => {
        if (msg.role === "system") {
            systemPromptFound = true;
            // ✅ CHANGE: STRICT LENGTH CONTROL ADDED
            const strictInstructions = `
            \n[IMPORTANT INSTRUCTIONS]:
            1. **KEEP IT SHORT:** Maximum 40-50 words. The user is listening to audio, so do not give long lectures.
            2. **Language:** Natural Hinglish. Warm & Professional.
            3. **NO JSON:** Just speak directly to the user.
            4. **Safety:** If user is abusive, politely refuse in Hinglish.
            `;
            return { ...msg, content: `${msg.content} ${strictInstructions}` };
        }
        return msg;
    });

    if (!systemPromptFound) {
        enhancedMessages.unshift({
            role: "system",
            content: `${DEFAULT_SYSTEM_PROMPT || "You are a helpful assistant."} \n[PROTOCOL]: Keep answers SHORT (Max 3 sentences). Respond in Hinglish.`,
        });
    }
    return enhancedMessages;
}

// --- MAIN CHAT FUNCTION ---
async function getAIChatResponse(messages) {
    if (!groqClient) return "System Offline.";

    const cacheKey = generateCacheKey(messages);
    if (cacheKey) {
        const cached = aiCache.get(cacheKey);
        if (cached) return cached;
    }

    const processedMessages = prepareMessagesForEnterprise(messages);
    const models = [MODELS_TIER_1, MODELS_TIER_2];

    for (const model of models) {
        try {
            const completion = await groqClient.chat.completions.create({
                model: model,
                messages: processedMessages,
                temperature: 0.3, 
                max_tokens: 150, // ✅ Reduced tokens to force short answers
            });
            
            const content = completion.choices[0]?.message?.content;
            if (content) {
                aiCache.set(cacheKey, content);
                return content;
            }
        } catch (error) {
            console.warn(`⚠️ Model ${model} failed. Switching... (${error.message})`);
        }
    }
    return "Abhi system thoda busy hai.";
}

module.exports = { getAIChatResponse };