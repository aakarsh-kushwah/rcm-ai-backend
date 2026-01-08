/**
 * @file src/controllers/chatController.js
 * @description Logic: DB Audio Priority -> AI Generation -> No DB Save -> Admin Alert.
 */

const { getAIChatResponse } = require('../services/aiService'); 
const { generateEdgeAudio } = require('../services/edgeTtsService');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const { db } = require('../config/db');
const asyncHandler = require('express-async-handler');
const stringSimilarity = require("string-similarity");

let { SYSTEM_PROMPT } = require('../utils/prompts');

// ✅ Admin Alert Wrapper (Isse mene change nahi kiya, ye zaroori he)
let sendAdminAlert = async () => {};
try {
    const bot = require('../services/whatsAppBot');
    if(bot.sendAdminAlert) sendAdminAlert = bot.sendAdminAlert;
} catch(e) {}

function sanitizeInput(text) {
    if (!text) return "";
    return text.substring(0, 500).trim().replace(/[<>{}]/g, ""); 
}

// 🚀 MAIN USER CHAT
const handleChat = asyncHandler(async (req, res) => {
    const start = Date.now();
    const { message, userId } = req.body; 

    if (!message) return res.status(400).json({ success: false, reply: "Message missing." });
    
    const cleanMsg = sanitizeInput(message);
    const userMsgForMatching = cleanMsg.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, ''); 

    let replyContent = "";
    let audioUrl = ""; 
    let source = "AI_LIVE"; 

    // ============================================================
    // 1. 🔍 DB CHECK (Priority: Check FAQ Table First)
    // ============================================================
    try {
        const approvedFaqs = await db.FAQ.findAll({
            where: { status: 'APPROVED' }, 
            attributes: ['question', 'answer', 'audioUrl', 'voiceType']
        });
        
        if (approvedFaqs.length > 0) {
            const questions = approvedFaqs.map(f => f.question.toLowerCase());
            const match = stringSimilarity.findBestMatch(userMsgForMatching, questions);
            
            // Agar 75% se zyada match hua to DB se jawaab denge
            if (match.bestMatch.rating > 0.75) {
                const bestFaq = approvedFaqs[match.bestMatchIndex];
                replyContent = bestFaq.answer;
                
                // 🔥 CRITICAL: Agar Audio DB mein hai, wahi use karo
                if (bestFaq.audioUrl && bestFaq.audioUrl.length > 5) {
                    audioUrl = bestFaq.audioUrl;
                    source = "DB_AUDIO_HIT";
                } else {
                    source = "DB_TEXT_ONLY";
                }
            }
        }
    } catch (e) {
        console.error("DB Check Error:", e.message);
    }

    // ============================================================
    // 2. 🧠 AI GENERATION (Agar DB me nahi mila)
    // ============================================================
    if (!replyContent) {
        try {
            replyContent = await getAIChatResponse([
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: cleanMsg }
            ]);
        } catch (e) { replyContent = "Network issue."; }

        // 3. 🔊 AUDIO GENERATION (Only for New AI Responses)
        if (!audioUrl && replyContent) {
            try {
                // AI se audio banega par DB me save nahi hoga
                audioUrl = await generateEdgeAudio(replyContent);
            } catch (e) { audioUrl = ""; }
        }
    }

    // 4. 📤 SEND RESPONSE
    res.status(200).json({ 
        success: true, 
        reply: replyContent,       
        message: replyContent,     
        audioUrl: audioUrl || "", 
        source: source,
        latency: `${Date.now() - start}ms`
    });

    // ============================================================
    // 5. 📦 LOGGING & ALERTS (Modified as per request)
    // ============================================================
    setImmediate(async () => {
        try {
            // 1. User ki Chat History me save karo (Ye user ko apni history dekhne ke liye chahiye)
            if (userId) {
                await db.ChatMessage.create({ 
                    userId, 
                    sender: "USER", 
                    message: cleanMsg, 
                    response: replyContent, 
                    audioUrl: audioUrl || "" 
                });
            }

            // 2. Alert Logic (Updated)
            if (source === "AI_LIVE" && userMsgForMatching.length > 5) {
                
                // ❌ REMOVED: await db.FAQ.create(...) 
                // Ab ye DB me save nahi hoga taaki kachra na bhare.

                // ✅ KEPT: Admin Alert
                // Admin ko WhatsApp par pata chal jayega ki koi naya sawal aya hai
                sendAdminAlert(cleanMsg, replyContent).catch(err => console.log("Alert Error:", err.message));
            }
        } catch (e) {
            console.error("Logging Error:", e.message);
        }
    });
});

// ============================================================
// 🛡️ ADMIN CONTROLLERS (Ye wese hi rahenge)
// ============================================================
const addSmartResponse = asyncHandler(async (req, res) => {
    const { question, answer } = req.body;
    const audioUrl = req.file ? await uploadAudioToCloudinary(req.file.buffer, `admin_${Date.now()}`) : await generateEdgeAudio(answer);
    
    // Sirf Admin hi DB me data daal sakta hai
    await db.FAQ.create({ question, answer, audioUrl, status: 'APPROVED', isUserSubmitted: false });
    res.json({ success: true, message: "Saved" });
});

const upgradeToPremium = asyncHandler(async (req, res) => {
    const { faqId, answer } = req.body;
    const faq = await db.FAQ.findByPk(faqId);
    if (!faq) return res.status(404).json({ message: "Not found" });
    const updateData = { status: 'APPROVED' };
    if (answer) updateData.answer = answer;
    if (req.file) updateData.audioUrl = await uploadAudioToCloudinary(req.file.buffer, `upg_${faqId}`);
    await faq.update(updateData);
    res.json({ success: true, message: "Updated" });
});

const handleSpeak = asyncHandler(async (req, res) => {
    const url = await generateEdgeAudio(req.body.text);
    res.json({ success: true, audioUrl: url });
});

module.exports = { handleChat, addSmartResponse, upgradeToPremium, handleSpeak };