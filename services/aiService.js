// backend/services/aiService.js

const Groq = require("groq-sdk");

// ✅ सुरक्षित initialization
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

// --- ✅ प्रोडक्शन रेडी: मॉडल लिस्ट ---
// हम Llama 3 (बेस्ट) को ट्राई करेंगे, और अगर वह फेल होता है तो Mixtral (सेकंड बेस्ट) पर जाएँगे
const MODELS = [
    "llama3-70b-8192",      // 1. प्राइमरी (सबसे पावरफुल)
    "mixtral-8x7b-32768"   // 2. फॉलबैक (दूसरा सबसे अच्छा)
];

/**
 * Safely handles AI chat response with failover.
 * @param {Array<Object>} messages - Chat messages array.
 * @returns {Promise<string>} - AI-generated message (text or JSON string) or an error message.
 */
async function getAIChatResponse(messages) {
    // 1️⃣ Groq client है या नहीं, यह चेक करें
    if (!groqClient) {
        console.error("🚫 Groq client not initialized (missing API key).");
        return "⚠️ AI service is unavailable. Please contact the administrator.";
    }

    // 2️⃣ बेसिक वैलिडेशन
    if (
        !messages ||
        !Array.isArray(messages) ||
        messages.length === 0 ||
        !messages.some((m) => m.role === "user")
    ) {
        return "⚠️ Invalid input: No user message provided.";
    }

    // 3️⃣ ✅ "Heavy Traffic" के लिए मल्टिपल मॉडल को ट्राई करें
    for (const model of MODELS) {
        try {
            const chatCompletion = await groqClient.chat.completions.create({
                model: model,
                messages,
                temperature: 0.5,
            });
            
            const content = chatCompletion?.choices?.[0]?.message?.content;
            
            if (content) {
                // 4️⃣ सफल जवाब
                // (यह एक टेक्स्ट स्ट्रिंग या JSON स्ट्रिंग हो सकती है, जिसे chatController हैंडल करेगा)
                return content; 
            }
            // अगर content खाली है, तो अगले मॉडल को ट्राई करें
            console.warn(`⚠️ Groq model "${model}" returned empty content.`);

        } catch (error) {
            // अगर यह मॉडल फेल होता है, तो अगले को ट्राई करें
            console.warn(`❌ Groq model "${model}" failed:`, error.message);
            // (अगले लूप में अगला मॉडल ट्राई होगा)
        }
    }

    // 5️⃣ अगर सारे मॉडल फेल हो जाएँ
    console.error("❌ All Groq models failed to respond.");
    return "⚠️ AI service is temporarily overloaded. Please try again in a moment.";
}

module.exports = { getAIChatResponse };