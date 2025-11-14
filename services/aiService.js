const Groq = require("groq-sdk");
const { SYSTEM_PROMPT } = require('../utils/prompts');

// =====================================================
// 1. GROQ INITIALIZATION
// =====================================================

let groqClient = null;

try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        console.warn("⚠️ GROQ_API_KEY missing. AI disabled.");
    } else {
        groqClient = new Groq({ apiKey });
        console.info("✅ Groq client initialized");
    }
} catch (err) {
    console.error("❌ Failed to initialize Groq:", err.message);
}

// =====================================================
// 2. MODELS TO USE (UPDATED, WORKING MODELS)
// =====================================================

const MODELS_TO_ATTEMPT = [
    "llama-3.3-70b-versatile",
    "gemma2-9b-it",
    "openai/gpt-oss-120b",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "moonshotai/kimi-k2-instruct-0905"
];

// System Prompt
const DEFAULT_SYSTEM_PROMPT = SYSTEM_PROMPT;


// =====================================================
// 3. PREPARE MESSAGES
// =====================================================

function prepareMessagesForGroq(incomingMessages) {
    const cleanedMessages = incomingMessages.filter(
        (msg) => msg && msg.role && typeof msg.content === "string" && msg.content.trim() !== ""
    );

    const hasSystem = cleanedMessages.some((m) => m.role === "system");

    if (!hasSystem) {
        cleanedMessages.unshift({
            role: "system",
            content: DEFAULT_SYSTEM_PROMPT,
        });
    }

    return cleanedMessages;
}

// =====================================================
// 4. ERROR JSON RESPONSE
// =====================================================

function createErrorResponse(message) {
    return JSON.stringify({
        type: "text",
        content: message,
    });
}

// =====================================================
// 5. MAIN AI FUNCTION (WITH FAILOVER LOGIC)
// =====================================================

async function getAIChatResponse(messages) {
    if (!groqClient) {
        console.error("🚫 Groq missing API key");
        return createErrorResponse("⚠️ AI is unavailable. Contact admin.");
    }

    if (
        !messages ||
        !Array.isArray(messages) ||
        !messages.some((m) => m.role === "user")
    ) {
        console.warn("🚫 Invalid input");
        return createErrorResponse("⚠️ Invalid input: No user message found.");
    }

    const processedMessages = prepareMessagesForGroq(messages);

    for (const model of MODELS_TO_ATTEMPT) {
        try {
            const chatCompletion = await groqClient.chat.completions.create({
                model,
                messages: processedMessages,
                temperature: 0.4,
                max_tokens: 1024,
                response_format: { type: "json_object" },
            });

            const content = chatCompletion?.choices?.[0]?.message?.content;
            if (content) return content;
        } catch (err) {
            console.warn(`❌ Model failed: ${model}`, err.message);

            // Fallback try without JSON mode
            try {
                const fallback = await groqClient.chat.completions.create({
                    model,
                    messages: processedMessages,
                    temperature: 0.4,
                    max_tokens: 1024,
                });

                const fallbackContent = fallback?.choices?.[0]?.message?.content;
                if (fallbackContent) {
                    return JSON.stringify({
                        type: "text",
                        content: fallbackContent,
                    });
                }
            } catch {
                continue;
            }
        }
    }

    return createErrorResponse("⚠️ AI overloaded. Try again later.");
}

module.exports = { getAIChatResponse };
