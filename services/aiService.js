const Groq = require("groq-sdk");

// ✅ Safe initialization
let groqClient = null;

try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        console.warn(
            "⚠️ GROQ_API_KEY is missing! Groq AI features will be disabled."
        );
    } else {
        groqClient = new Groq({ apiKey });
        console.log("✅ Groq client initialized successfully.");
    }
} catch (err) {
    console.error("❌ Failed to initialize Groq client:", err.message);
}

// ✅ Model selection (use stable and supported one)
const MODEL = "openai/gpt-oss-120b";

/**
 * Safely handles AI chat response.
 * @param {Array<Object>} messages - Chat messages array.
 * @returns {Promise<string>} - AI-generated message or fallback.
 */
async function getAIChatResponse(messages) {
    try {
        // 1️⃣ Basic validation
        if (
            !messages ||
            !Array.isArray(messages) ||
            messages.length === 0 ||
            !messages.some((m) => m.role === "user")
        ) {
            return "⚠️ Invalid input: No user message provided.";
        }

        // 2️⃣ Ensure Groq client is ready
        if (!groqClient) {
            console.error("🚫 Groq client not initialized (missing API key).");
            return "⚠️ AI service unavailable. Please contact the administrator.";
        }

        // 3️⃣ Call Groq API
        const chatCompletion = await groqClient.chat.completions.create({
            model: MODEL,
            messages,
            temperature: 0.5,
        });

        // 4️⃣ Extract response
        return (
            chatCompletion?.choices?.[0]?.message?.content ||
            "🤖 Sorry, I couldn't generate a response."
        );
    } catch (error) {
        console.error("❌ Groq AI Service Error:", error.message);
        return "⚠️ An internal error occurred while processing your request.";
    }
}

module.exports = { getAIChatResponse };
