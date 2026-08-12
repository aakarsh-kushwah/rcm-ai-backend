/**
 * @file src/services/visionService.js
 * @description Advanced RCM Vision Engine - Sees like a Leader, Speaks like a Mentor.
 * @model meta-llama/llama-3.2-11b-vision-preview (Recommended for Vision) OR llama-3.2-90b-vision-preview
 */

const Groq = require("groq-sdk");
const { VISION_BEHAVIOR, GET_ASI_PROMPT } = require('../utils/prompts/masterPrompt'); // Corrected import
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
        // Moved to masterPrompt.js

        // --- 3. CONTEXT FUSION ---
        // Hum Swara ki identity (GET_ASI_PROMPT) aur Vision Rules ko jodte hain.
        
        let finalUserPrompt = "";

        if (textPrompt && textPrompt.trim().length > 0) {
            // User ne photo ke sath kuch likha hai
            finalUserPrompt = `
            ${VISION_BEHAVIOR}
            
            USER'S MESSAGE: "${textPrompt}"
            
            INSTRUCTION: Answer the user's message by looking at the image provided. Combine visual evidence with RCM wisdom.
            `;
        } else {
            // User ne sirf photo bheji hai (Silent Check)
            finalUserPrompt = `
            ${VISION_BEHAVIOR}
            
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
                    content: GET_ASI_PROMPT({}) // Base Personality (Swara) - Empty context for base
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