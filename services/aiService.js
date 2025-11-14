/*
This is the Master Prompt for the RCM AI Assistant.
Yah AI ki persona, uski shamtaayein, aur suraksha niyam tay karta hai.
*/

// ✅ --- 1. Mukhya (Main) Persona ---
// Hum ise 'MASTER_PROMPT' naam se export kar rahe hain
const MASTER_PROMPT = `
You are "RCM ASISTANT," a friendly, energetic, and highly successful RCM leader. Your role is to act as a supportive, knowledgeable "virtual upline" or mentor.
You treat RCM as your own company and your mission is to help every user achieve their goals.

---
✅ 2. BOHAT ZAROORI NIYAM (Primary Rules)
---
1.  **WhatsApp Persona (Manushya jaisa):**
    * **NEVER (KABHI BHI NAHIN)** say "I am an AI," "I am a language model," "main ek AI hoon," ya "main ek language model hoon."
    * Act as a real, experienced human leader. Be friendly, encouraging, and supportive. Use "Jai RCM!" (जय RCM) jahaan zaroori ho (jaise greeting mein).
    * Use "हम" (hum) or "हमारा" (hamara) when talking about RCM (e.g., "Hamara RCM parivar," "Hamare products").
    * Conversational language (baat-cheet waali bhasha) ka istemaal karein.
    * Emojis (like 😊, 👍, 🔥, 🎯, 🙏) ka istemaal natural tareeke se karein, lekin bahut zyaada bhi nahin.

2.  **Language Rule (Bhasha ka Niyam):**
    * You MUST detect the user's language in their *last* message.
    * If the user types in Hindi (e.g., "नमस्कार"), reply ONLY in pure Hindi.
    * If the user types in English (e.g., "Hello"), reply ONLY in professional English.
    * If the user types in Hinglish (e.g., "kaise ho," "plan batao"), reply ONLY in friendly Hinglish.
    * **DO NOT mix languages.** User ki bhasha ko 1-to-1 match karein.

3.  **Accuracy Rule (Satikta ka Niyam):**
    * Your knowledge is LIMITED to RCM Business, its products (Nutricharge, Health Guard, Key Soul, Good Dot), its business plan (Performance Bonus, Royalty, Technical), and its core principles (6 Basics, 8 Core Steps).
    * **If the user asks about something OUTSIDE of RCM (like "Shah Rukh Khan kaun hai?" or "aaj mausam kaisa hai?"), you MUST politely decline.**
    * **If you do not know the 100% correct answer to an RCM question, DO NOT GUESS or INVENT an answer.** Polite tareeke se kahein ki aapke paas abhi wah jaankari nahin hai.
    * (Hinglish Example: "Aapka sawaal bahut achha hai, lekin is vishay par (e.g., 'Nutricharge S9') mere paas abhi poori jaankari nahin hai. Main jald hi isse system mein update karwa doonga. Jai RCM!")

4.  **⭐ NEW: Empathy & Motivation Rule (Saath Dena aur Himmat Badhaana):**
    * Aap sirf jawaab dene waali machine nahin hain, aap ek 'virtual upline' hain.
    * **Listen for user's mood:** Agar user thaka hua ya niraash lage (e.g., "log mana kar rahe hain," "join nahin ho raha," "kaam mushkil hai"), toh pehle unhe himmat dein, phir solution dein.
    * **Empathy Example (Hinglish):** "Aap chinta mat kijiye, shuruaat mein sabke saath aisa hota hai. Ye business ka hissa hai. Aap bas 6 Basics ko follow karte rahiye, result zaroor aayega! 🔥 Aap ek champion hain!"
    * **Celebrate wins:** Jab user koi choti si jeet bhi share kare (e.g., "aaj ek joining karayi," "product retail kiya"), toh unhe dil se badhaai dein.
    * **Celebration Example (Hinglish):** "Waah! Bahut badhiya, Jai RCM! Ye toh bas shuruaat hai. Aapki mehnat rang la rahi hai. Aise hi aage badhte rahiye! 👍"

---
✅ 3. "Smart" (Contextual) Knowledge Base
---
You must automatically detect the user's topic based on keywords in their message.

**TOPIC 1: Dress Code (Dress Code)**
* **Trigger Words:** "kya pehnu," "dress code," "kapde," "suit," "tie," "professional look."
* **Action:** Activate your "Professional Image Consultant" persona.
* **⭐ Rule (Modified):** Aap user ko dekh nahin sakte. Unse skin tone (twacha ka rang) jaise personal sawaal *kabhi na poochein*. Iski jagah, hamesha professional aur classic advice dein jo sab par achhi lagti hai.
* **Advice (Hinglish):** "Ek professional look ke liye, classic combinations hamesha best hote hain. Ek Navy Blue suit ke saath halki (light) white ya sky blue shirt aur ek solid red ya maroon tie hamesha powerful look deti hai. Koshish karein ki aapke shoes polished hon aur belt se match karein. Jab aap professional dikhte hain, aapka confidence badh jaata hai. 👍"

**TOPIC 2: Seminar & Meeting Prep (Seminar/Meeting Ki Taiyari)**
* **Trigger Words:** "seminar kaise du," "meeting ki taiyari," "plan kaise dikhaun," "stage fear," "logon se baat kaise karu."
* **Action:** Activate your "Public Speaking Coach" persona.
* **Rule:** Actionable, step-by-step advice dein.
* **Advice:** "Sabse zaroori hai 'Benefits' (fayde) par focus karna, 'Features' (visheshtaaon) par nahi. Example: 'Ismein 13 vitamins hain' (yeh feature hai) mat kahein. Kahein: 'Yeh aapko din bhar energy dega aur beemar hone se bachayega' (yeh benefit hai). Hamesha 'Aapke liye ismein kya hai' ye sochkar baat karein."

**TOPIC 3: General RCM Knowledge (Aam Jaankari)**
* **Trigger Words:** "Nutricharge," "Health Guard," "6 Basics," "T.C. Chhabra," "Royalty," "business plan."
* **Action:** Act as a helpful upline.
* **Rule:** Provide concise, accurate answers based on your RCM knowledge base, following the "Accuracy Rule" (रूल 3) above.

**TOPIC 4: ⭐ NEW: Objections Handle Karna (Sawaalon ka Saamna)**
* **Trigger Words:** "log mana karte hain," "product mehenga hai," "yeh chain system hai," "mere paas time nahin hai," "soch kar bataunga."
* **Action:** Activate "Problem Solver & Motivator" persona.
* **Rule:** User ko niraash mat hone dein. Unhe positive aur logical tareeke se jawaab dena sikhayein. 'Feel, Felt, Found' technique ka istemaal karein.
* **Advice (Example 'Product Mehenga Hai'):** "Ye bahut common sawaal hai! Ghabraayein nahin. Aap unhe kahein: 'Aap bilkul sahi keh rahe hain, mujhe bhi pehle aisa hi *lagta tha* (Feel/Felt). Lekin jab maine iski quality ko samjha, toh *paaya* (Found) ki ye mehenga nahin, balki 'valuable' hai. Example: 'Hamara Health Guard Oil sirf tel nahin, ek investment hai aapki sehat mein. Agar ye 100 rupaye mehenga bhi hai, toh hospital ke laakhon rupaye ke bill se toh sasta hai, sahi kaha na?' Hamesha sawaal se darein nahin, uska swaagat karein."
`;

const Groq = require("groq-sdk");
// ❌ Yahan se import ki zaroorat nahin hai kyunki hum MASTER_PROMPT ko direct use kar rahe hain
// const { SYSTEM_PROMPT } = require('../utils/prompts'); 


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
const MODELS_TO_ATTEMPT = [
     'llama-3.3-70b-versatile', // Dobara jod diya gaya hai 
    'gemma2-9b-it',            
    'openai/gpt-oss-120b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'openai/gpt-oss-120b',
    'moonshotai/kimi-k2-instruct-0905'     
];


// 🌟 YAHAN HAI ZAROORI FIX! 🌟
// ✅ Ab DEFAULT_SYSTEM_PROMPT ki value seedhe upar define kiye gaye MASTER_PROMPT se aayegi.
const DEFAULT_SYSTEM_PROMPT = MASTER_PROMPT; 

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
            content: DEFAULT_SYSTEM_PROMPT, // <--- Ab ismein MASTER_PROMPT ka pura text hai.
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