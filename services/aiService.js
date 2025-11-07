const Groq = require("groq-sdk");
// ✅ Naye prompt ko yahaan import karein
const { SYSTEM_PROMPT } = require('../utils/prompts');

// --- 1. कॉन्फिगरेशन (Configuration) ---

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

// ✅ --- YEH HAI MUKHYA FIX (Models Update) ---
// In models ko update kar diya gaya hai kyunki 'llama-3.1-70b-versatile' band ho chuka hai.
const MODELS_TO_ATTEMPT = [
     'llama-3.3-70b-versatile', 
    'gemma2-9b-it',            
    'openai/gpt-oss-120b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'openai/gpt-oss-20b',

'moonshotai/kimi-k2-instruct-0905'     
];



// ✅ Default system prompt ab aapka RCM prompt hai.
const DEFAULT_SYSTEM_PROMPT = SYSTEM_PROMPT; 

// --- 2. हेल्पर फंक्शन (Helper Function) ---

/**
 * 🚨 यह फंक्शन API में भेजने से पहले 'messages' ऐरे को साफ और सुरक्षित करता है।
 * ✅ Isko saral (simplify) kar diya gaya hai.
 *
 * @param {Array<Object>} incomingMessages - क्लाइंट से आया हुआ मैसेज ऐरे।
 * @returns {Array<Object>} - Groq API के लिए एक सुरक्षित और मान्य (valid) ऐरे।
 */
function prepareMessagesForGroq(incomingMessages) {
    
    // 1. Sabhi valid messages ko filter karein
    const cleanedMessages = incomingMessages.filter(
        (msg) => msg && msg.role && typeof msg.content === 'string' && msg.content.trim() !== ''
    );

    // 2. Check karein ki 'system' role ka message pehle se hai ya nahi
    const hasSystemPrompt = cleanedMessages.some(msg => msg.role === "system");

    // 3. Agar koi system prompt nahi mila, toh hamara RCM wala default prompt sabse aage jod dein
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

    // 3️⃣ 🚨 महत्वपूर्ण: मैसेज को API के लिए तैयार करें (Updated logic)
    const processedMessages = prepareMessagesForGroq(messages);

    // 4️⃣ मॉडल फेलओवर लूप: एक-एक करके मॉडल ट्राई करें
    for (const model of MODELS_TO_ATTEMPT) {
        try {
            // console.log(`Attempting model: ${model}`); // Debugging ke liye
            const chatCompletion = await groqClient.chat.completions.create({
                model: model,
                messages: processedMessages,
                temperature: 0.5, 
                max_tokens: 1024,
                // ✅ Naya parameter: JSON output ke liye force karein
                // Taa ki 'type: "calculator"' hamesha JSON mein aaye
                response_format: { type: "json_object" }, 
            });
            
            const content = chatCompletion?.choices?.[0]?.message?.content;
            
            if (content) {
                // 5️⃣ ✅ सफलता!
                return content; 
            }
            
            console.warn(`⚠️ Groq model "${model}" returned empty content.`);

        } catch (error) {
            console.warn(`❌ Groq model "${model}" failed (JSON format):`, error.message);
            
            // ✅ Production-Ready Fallback:
            // Agar model JSON format support nahi karta ya fail hota hai,
            // toh hum bina JSON format ke dobara try karenge.
            console.warn(`Retrying model "${model}" without JSON response format...`);
            try {
                const fallbackCompletion = await groqClient.chat.completions.create({
                    model: model,
                    messages: processedMessages,
                    temperature: 0.5,
                    max_tokens: 1024,
                });
                
                const fallbackContent = fallbackCompletion?.choices?.[0]?.message?.content;
                if (fallbackContent) {
                    // Isse JSON structure mein wrap karein
                    return JSON.stringify({
                        type: "text",
                        content: fallbackContent,
                    });
                }
            } catch (fallbackError) {
                    console.warn(`❌ Fallback attempt for model "${model}" also failed:`, fallbackError.message);
            }
        }
    }

    // 6️⃣ ❌ अंतिम विफलता: अगर सारे मॉडल फेल हो जाएँ
    console.error("❌ All Groq models failed to respond. Service is likely overloaded.");
    return createErrorResponse(
        "⚠️ AI service is temporarily overloaded. Please try again in a moment."
    );
}

module.exports = { getAIChatResponse };