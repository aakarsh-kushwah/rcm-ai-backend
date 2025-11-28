const Groq = require("groq-sdk");
const { MASTER_PROMPT } = require('../utils/prompts'); // Ensure correct import path

let groqClient = null;

// --- 1. Config ---
try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.warn("⚠️ GROQ_API_KEY is missing!");
    } else {
        groqClient = new Groq({ apiKey });
        console.info("✅ Groq client initialized.");
    }
} catch (err) {
    console.error("❌ Failed to initialize Groq:", err.message);
}

// Updated Models List
const MODELS_TO_ATTEMPT = [
    'llama-3.3-70b-versatile',
    'llama3-70b-8192',
    'mixtral-8x7b-32768'
];

// Default Prompt if none provided
const DEFAULT_SYSTEM_PROMPT = MASTER_PROMPT || "You are a helpful assistant.";

// --- 2. Helper Function ---
function prepareMessagesForGroq(incomingMessages) {
    // Filter valid messages
    const cleanedMessages = incomingMessages.filter(
        (msg) => msg && msg.role && typeof msg.content === 'string' && msg.content.trim() !== ''
    );

    let hasSystemPrompt = false;

    // ✅ CRITICAL FIX: Ensure "JSON" keyword exists in system prompt
    const finalMessages = cleanedMessages.map(msg => {
        if (msg.role === "system") {
            hasSystemPrompt = true;
            // Groq requires the word "json" to be present if response_format is json_object
            if (!msg.content.toLowerCase().includes("json")) {
                return { 
                    ...msg, 
                    content: msg.content + " IMPORTANT: You must respond in strict JSON format." 
                };
            }
        }
        return msg;
    });

    // If no system prompt, add one with JSON instruction
    if (!hasSystemPrompt) {
        finalMessages.unshift({
            role: "system",
            content: DEFAULT_SYSTEM_PROMPT + " IMPORTANT: You must respond in strict JSON format.",
        });
    }
    
    return finalMessages;
}

function createErrorResponse(message) {
    return JSON.stringify({ type: "text", content: message });
}

// --- 3. Main Service ---
async function getAIChatResponse(messages) {
    if (!groqClient) return createErrorResponse("AI service unavailable.");

    // Prepare messages with JSON instruction
    const processedMessages = prepareMessagesForGroq(messages);

    for (const model of MODELS_TO_ATTEMPT) {
        try {
            // Attempt 1: JSON Mode
            const chatCompletion = await groqClient.chat.completions.create({
                model: model,
                messages: processedMessages,
                temperature: 0.6, 
                max_tokens: 1024,
                // ✅ This requires "json" word in messages (handled above)
                response_format: { type: "json_object" }, 
            });
            
            const content = chatCompletion?.choices?.[0]?.message?.content;
            if (content) return content; 

        } catch (error) {
            console.warn(`❌ Groq model "${model}" failed (JSON mode):`, error.message);
            
            // Attempt 2: Fallback to Text Mode (Safe Mode)
            // If JSON mode fails, try without forcing JSON structure
            try {
                console.warn(`Retrying "${model}" in text mode...`);
                const fallbackCompletion = await groqClient.chat.completions.create({
                    model: model,
                    messages: processedMessages,
                    temperature: 0.6,
                    max_tokens: 1024,
                    // No response_format here
                });
                
                let fallbackContent = fallbackCompletion?.choices?.[0]?.message?.content;
                
                if (fallbackContent) {
                    // Manually wrap text response in JSON to keep frontend happy
                    // Check if it's already JSON string
                    try {
                        JSON.parse(fallbackContent);
                        return fallbackContent;
                    } catch (e) {
                        return JSON.stringify({ type: "text", content: fallbackContent });
                    }
                }
            } catch (e) { 
                console.warn(`Fallback failed for ${model}:`, e.message);
            }
        }
    }

    console.error("❌ All Groq models exhausted.");
    return createErrorResponse("I'm having trouble thinking right now. Please try again.");
}

module.exports = { getAIChatResponse };