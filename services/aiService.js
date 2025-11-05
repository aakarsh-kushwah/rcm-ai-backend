// backend/services/aiService.js
const Groq = require("groq-sdk");

// --- 1. कॉन्फिगरेशन (Configuration) ---

let groqClient = null;

try {
    // एनवायरनमेंट वेरिएबल्स से API की (key) लोड करें
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        // यह एक चेतावनी (warning) है, एरर (error) नहीं, ताकि ऐप क्रैश न हो
        console.warn(
            "⚠️ GROQ_API_KEY is missing! Groq AI features will be disabled. Service will return fallback messages."
        );
    } else {
        groqClient = new Groq({ apiKey });
        console.info("✅ Groq client initialized successfully.");
    }
} catch (err) {
    // यह एक गंभीर एरर है, अगर SDK लोड होने में विफल हो
    console.error("❌ Failed to initialize Groq client:", err.message);
}

// प्रोडक्शन-रेडी मॉडल लिस्ट (Failover क्रम में)
// हम सबसे तेज़ और शक्तिशाली मॉडल को पहले ट्राई करेंगे।
const MODELS_TO_ATTEMPT = [
    "llama-3.3-70b-versatile", // 1. प्राइमरी (सबसे पावरफुल)
    "gemma2-9b-it"             // 2. फॉलबैक (अगर प्राइमरी फेल हो)
];

// डिफ़ॉल्ट सिस्टम प्रॉम्प्ट, अगर क्लाइंट नहीं भेजता है
const DEFAULT_SYSTEM_PROMPT = "You are a helpful and concise assistant.";

// --- 2. हेल्पर फंक्शन (Helper Function) ---

/**
 * 🚨 यह फंक्शन API में भेजने से पहले 'messages' ऐरे को साफ और सुरक्षित करता है।
 * यह उस 400 एरर को ठीक करता है जो आपने लॉग्स में देखा था।
 *
 * @param {Array<Object>} incomingMessages - क्लाइंट से आया हुआ मैसेज ऐरे।
 * @returns {Array<Object>} - Groq API के लिए एक सुरक्षित और मान्य (valid) ऐरे।
 */
function prepareMessagesForGroq(incomingMessages) {
    let hasSystemPrompt = false;
    
    // 1. सभी मैसेज को साफ करें और सिस्टम प्रॉम्प्ट को ठीक करें
    const cleanedMessages = incomingMessages
        .map((msg) => {
            // अमान्य मैसेज को यहीं रोक दें
            if (!msg || !msg.role || typeof msg.content !== 'string') {
                return null;
            }

            if (msg.role === "system") {
                hasSystemPrompt = true;
                // 🚨 क्रिटिकल फिक्स:
                // अगर 'role: system' है, लेकिन 'content' खाली (empty) या मौजूद नहीं है,
                // तो हम डिफ़ॉल्ट प्रॉम्प्ट सेट करते हैं। यह 400 एरर को रोकता है।
                return {
                    role: "system",
                    content: msg.content || DEFAULT_SYSTEM_PROMPT,
                };
            }
            
            return {
                role: msg.role,
                content: msg.content
            };
        })
        .filter(Boolean); // सभी null (अमान्य) मैसेज को हटा दें

    // 2. अगर कोई भी सिस्टम प्रॉम्प्ट नहीं मिला, तो एक डिफ़ॉल्ट प्रॉम्प्ट सबसे आगे जोड़ें
    if (!hasSystemPrompt) {
        cleanedMessages.unshift({
            role: "system",
            content: DEFAULT_SYSTEM_PROMPT,
        });
    }

    return cleanedMessages;
}

/**
 * एक मानकीकृत (standardized) एरर रिस्पॉन्स बनाता है।
 * @param {string} message - क्लाइंट को दिखाने वाला एरर मैसेज।
 * @returns {string} - JSON स्ट्रिंग
 */
function createErrorResponse(message) {
    return JSON.stringify({
        type: "text",
        content: message,
    });
}

// --- 3. मुख्य सर्विस फंक्शन (Main Service Function) ---

/**
 * AI चैट रिस्पॉन्स को सुरक्षित रूप से हैंडल करता है, जिसमें मॉडल फेलओवर (failover) भी शामिल है।
 * ✅ यह फंक्शन हमेशा एक JSON स्ट्रिंग ही रिटर्न करेगा (सफलता या विफलता दोनों में)।
 *
 * @param {Array<Object>} messages - क्लाइंट से आया हुआ चैट मैसेज ऐरे।
 * @returns {Promise<string>} - एक JSON स्ट्रिंग जिसमें 'type' और 'content' होगा।
 */
async function getAIChatResponse(messages) {
    // 1️⃣ गार्ड क्लॉज: क्या Groq क्लाइंट शुरू हुआ था?
    if (!groqClient) {
        console.error("🚫 Groq service called, but client is not initialized (missing API key).");
        return createErrorResponse(
            "⚠️ AI service is unavailable. Please contact the administrator."
        );
    }

    // 2️⃣ गार्ड क्लॉज: क्या इनपुट वैलिड है?
    if (
        !messages ||
        !Array.isArray(messages) ||
        messages.length === 0 ||
        !messages.some((m) => m.role === "user")
    ) {
        console.warn("🚫 Invalid input blocked: No user message provided.");
        return createErrorResponse(
            "⚠️ Invalid input: No user message provided."
        );
    }

    // 3️⃣ 🚨 महत्वपूर्ण: मैसेज को API के लिए तैयार करें (यही फिक्स है)
    const processedMessages = prepareMessagesForGroq(messages);

    // 4️⃣ मॉडल फेलओवर लूप: एक-एक करके मॉडल ट्राई करें
    for (const model of MODELS_TO_ATTEMPT) {
        try {
            const chatCompletion = await groqClient.chat.completions.create({
                model: model,
                messages: processedMessages,
                temperature: 0.5, // थोड़ी क्रिएटिविटी के लिए
                max_tokens: 1024,  // बहुत लंबा जवाब न दे
            });
            
            const content = chatCompletion?.choices?.[0]?.message?.content;
            
            if (content) {
                // 5️⃣ ✅ सफलता!
                // एक जैसा रिस्पॉन्स स्ट्रक्चर भेजें (एरर जैसा ही)
                return JSON.stringify({
                    type: "text",
                    content: content,
                });
            }
            
            // यह तब होगा जब API 200 OK भेजे, लेकिन content खाली हो
            console.warn(`⚠️ Groq model "${model}" returned empty content.`);

        } catch (error) {
            // यह तब होगा जब API क्रैश हो (जैसे 500, 429, या 400 एरर)
            console.warn(`❌ Groq model "${model}" failed:`, error.message);
            // अगले मॉडल को ट्राई करने के लिए लूप जारी रखें...
        }
    }

    // 6️⃣ ❌ अंतिम विफलता: अगर सारे मॉडल फेल हो जाएँ
    console.error("❌ All Groq models failed to respond. Service is likely overloaded.");
    return createErrorResponse(
        "⚠️ AI service is temporarily overloaded. Please try again in a moment."
    );
}

module.exports = { getAIChatResponse };