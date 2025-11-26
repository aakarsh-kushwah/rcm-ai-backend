const Groq = require("groq-sdk");
const { SYSTEM_PROMPT } = require('../utils/prompts');

let groqClient = null;

try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.warn(
            "⚠️ GROQ_API_KEY is missing! Groq AI features will be disabled. Service will return fallback messages."
        );
    } else {
        groqClient = new Groq({ apiKey });
        console.info("✅ Groq client initialized successfully.");
    }
} catch (err) {
    console.error("❌ Failed to initialize Groq client:", err.message);
}

// Models list updated to current supported ones
const MODELS_TO_ATTEMPT = [
    'llama-3.3-70b-versatile',
    'llama3-70b-8192',
    'mixtral-8x7b-32768'
];

const DEFAULT_SYSTEM_PROMPT = SYSTEM_PROMPT; 

/**
 * Prepares messages for Groq API.
 * CRITICAL FIX: Injects the word "JSON" into the system prompt if missing.
 * This resolves the 400 error: "'messages' must contain the word 'json'..."
 */
function prepareMessagesForGroq(incomingMessages) {
    // 1. Filter valid messages
    const cleanedMessages = incomingMessages.filter(
        (msg) => msg && msg.role && typeof msg.content === 'string' && msg.content.trim() !== ''
    );

    // 2. Check if system prompt exists and update it
    let hasSystemPrompt = false;
    
    // We use map to create a new array with modified content where necessary
    const finalMessages = cleanedMessages.map(msg => {
        if (msg.role === "system") {
            hasSystemPrompt = true;
            // ✅ Fix: If we want JSON output, the prompt MUST say "JSON" explicitly.
            if (!msg.content.toLowerCase().includes("json")) {
                return { 
                    ...msg, 
                    content: msg.content + " IMPORTANT: You must respond in strict JSON format." 
                };
            }
        }
        return msg;
    });

    // 3. If no system prompt found, add default with JSON instruction
    if (!hasSystemPrompt) {
        finalMessages.unshift({
            role: "system",
            content: DEFAULT_SYSTEM_PROMPT + " IMPORTANT: You must respond in strict JSON format.",
        });
    }
    
    return finalMessages;
}

function createErrorResponse(message) {
    return JSON.stringify({
        type: "text",
        content: message,
    });
}

async function getAIChatResponse(messages) {
    if (!groqClient) {
        return createErrorResponse("AI service is currently unavailable.");
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return createErrorResponse("Invalid input provided.");
    }

    // ✅ Apply the fix to messages
    const processedMessages = prepareMessagesForGroq(messages);

    for (const model of MODELS_TO_ATTEMPT) {
        try {
            // Attempt 1: Strict JSON Mode
            const chatCompletion = await groqClient.chat.completions.create({
                model: model,
                messages: processedMessages,
                temperature: 0.5, 
                max_tokens: 1024,
                response_format: { type: "json_object" }, // Requires "json" in prompt
            });
            
            const content = chatCompletion?.choices?.[0]?.message?.content;
            
            if (content) {
                return content; 
            }
            
        } catch (error) {
            console.warn(`❌ Groq model "${model}" failed (JSON mode):`, error.message);
            
            // Attempt 2: Fallback to Standard Text Mode
            // (Some older models or specific prompts might fail JSON mode validation)
            try {
                console.warn(`Retrying model "${model}" without JSON format enforcement...`);
                const fallbackCompletion = await groqClient.chat.completions.create({
                    model: model,
                    messages: processedMessages,
                    temperature: 0.5,
                    max_tokens: 1024,
                });
                
                const fallbackContent = fallbackCompletion?.choices?.[0]?.message?.content;
                if (fallbackContent) {
                    // If the model returned plain text, wrap it in our JSON structure manually
                    // so the frontend doesn't break.
                    try {
                        // Check if it happens to be valid JSON anyway
                        JSON.parse(fallbackContent);
                        return fallbackContent;
                    } catch (e) {
                        // Not JSON, wrap it
                        return JSON.stringify({
                            type: "text",
                            content: fallbackContent,
                        });
                    }
                }
            } catch (fallbackError) {
                console.warn(`❌ Fallback attempt for model "${model}" also failed:`, fallbackError.message);
            }
        }
    }

    console.error("❌ All Groq models failed to respond.");
    return createErrorResponse("I'm having trouble thinking right now. Please try again in a moment.");
}

module.exports = { getAIChatResponse };