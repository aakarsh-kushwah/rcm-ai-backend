/**
 * @file src/services/visionService.js
 * @description Advanced RCM Vision Engine - Sees like a Leader, Speaks like a Mentor.
 * @model meta-llama/llama-3.2-11b-vision-preview (Recommended for Vision) OR llama-3.2-90b-vision-preview
 */

const Groq = require("groq-sdk");
const { SYSTEM_PROMPT } = require('../utils/prompts'); // Swara's Soul (Identity)
require('dotenv').config();

const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY,
    timeout: 45 * 1000 // Thoda time extra diya taaki deep analysis kare
});

const analyzeImage = async (textPrompt, base64Image) => {
    try {
        console.log("👁️ Swara Vision: Scanning image with RCM Perspective...");

        if (!base64Image) throw new Error("Image data missing.");

        // --- 1. Intelligent Image Compression Check ---
        // (Calculates mostly accurate size from Base64 string)
        const sizeInBytes = (base64Image.length * 3) / 4 - 2; // '=' padding handling
        if (sizeInBytes > 4 * 1024 * 1024) {
            return "Arre ji, ye photo thodi zyada badi hai (4MB+). Kripya thodi chhoti file bhejiye, main turant dekh lungi.";
        }

        // --- 2. THE "HUMAN EYES" INSTRUCTION SET ---
        // Ye instructions model ko batati hain ki sirf dekhna nahi hai, REACT karna hai.
        
        const visionBehavior = `
        <VISION_MODE_ACTIVATED>
        You are now seeing the world through Swara's eyes (RCM Leader).
        
        **CRITICAL RULE:** DO NOT describe the image like a robot (e.g., "I see a bottle on a table"). 
        **INSTEAD:** React to it emotionally and contextually (e.g., "Waah! Nutricharge Women! Ye toh har ghar ki zarurat hai ji.").

        **SCENARIO HANDLING:**
        1. **RCM PRODUCTS:** Identify the specific product (Nutricharge, Good Dot, Key Soul). Validate it. Say something like "Great choice!" or explain a quick benefit.
        2. **NON-RCM PRODUCTS:** Be polite but loyal. Suggest switching. (e.g., "Ye sabun achha hoga, lekin RCM ka Neem Soap try kiya? Wo skin ke liye best hai.")
        3. **GROUP PHOTOS / MEETINGS:** Comment on the energy. Use words like "Team Spirit", "Utsah", "Future Diamonds".
        4. **TEXT / DOCUMENTS:** If it's a plan or bill, offer to explain the calculation (PV/BV).
        5. **UNCLEAR IMAGES:** Don't say "Image is blurry." Say "Maaf kijiye ji, photo thodi dhundhli hai. Dobara bhejengi?"
        
        **TONE REMINDER:** Use "Ji", "Sir/Ma'am", naturally. Keep it warm and encouraging.
        </VISION_MODE_ACTIVATED>
        `;

        // --- 3. CONTEXT FUSION ---
        // Hum Swara ki identity (SYSTEM_PROMPT) aur Vision Rules ko jodte hain.
        
        let finalUserPrompt = "";

        if (textPrompt && textPrompt.trim().length > 0) {
            // User ne photo ke sath kuch likha hai
            finalUserPrompt = `
            ${visionBehavior}
            
            USER'S MESSAGE: "${textPrompt}"
            
            INSTRUCTION: Answer the user's message by looking at the image provided. Combine visual evidence with RCM wisdom.
            `;
        } else {
            // User ne sirf photo bheji hai (Silent Check)
            finalUserPrompt = `
            ${visionBehavior}
            
            USER'S ACTION: Sent an image without text.
            
            INSTRUCTION: Look at the image and start a conversation. 
            - If it's a product, ask if they used it.
            - If it's a person, greet them warmly.
            - If random, ask context politely.
            `;
        }

        // --- 4. API CALL ---
        
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: SYSTEM_PROMPT // Base Personality (Swara)
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: finalUserPrompt
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: base64Image.startsWith('data:') ? base64Image : `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            // NOTE: Use a vision-capable model. 
            // 'llama-3.2-11b-vision-preview' is fast and free (mostly) on Groq currently.
            // 'llama-3.2-90b-vision-preview' is smarter but heavier.
            model: "llama-3.2-11b-vision-preview", 
            
            temperature: 0.6, // Slight creativity for natural reactions
            max_tokens: 500,  // Short, sweet answers
            top_p: 0.9,
            stream: false
        });

        const response = completion.choices[0]?.message?.content;
        
        if (!response) return "Maaf kijiye ji, internet ki wajah se dekh nahi paayi. Phir se bhejiye na.";
        
        return response;

    } catch (error) {
        console.error("🔴 Vision Error:", error.message);
        return "Abhi thodi technical dikkat aa rahi hai ji. Humari tech team isse dekh rahi hai.";
    }
};

module.exports = { analyzeImage };