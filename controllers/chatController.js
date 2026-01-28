/**
 * @file src/controllers/chatController.js
 * @description Optimized Flow: FAQ Cache -> Titan ASI Engine (Text/Vision) -> Response
 */

const asyncHandler = require('express-async-handler');
const stringSimilarity = require('string-similarity');

// UPDATED IMPORTS FOR ASI & VISION
const { generateTitanResponse, analyzeImageWithAI } = require('../services/aiService');
const { generateEdgeAudio } = require('../services/edgeTtsService');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const db = require('../models'); 
const { ChatMessage, FAQ, VoiceResponse, Product } = db; 

// ============================================================
// ⚙️ CONSTANTS & CONFIG (ADDED FOR EXPERT MATCHING)
// ============================================================
const BASE_THRESHOLD = 0.60; 
const SHORT_TEXT_THRESHOLD = 0.75; 

// ============================================================
// 🟡 ADMIN ALERT WRAPPER (Safe Mode)
// ============================================================
let sendAdminAlert = async () => {};
try {
    const bot = require('../services/whatsAppBot');
    if (bot.sendAdminAlert) sendAdminAlert = bot.sendAdminAlert;
} catch (_) {}

// ============================================================
// 🧼 HELPERS
// ============================================================
const sanitizeInput = (text = "") =>
    text.substring(0, 500).trim().replace(/[<>{}]/g, "");

// ============================================================
// 🚀 USER → AI CHAT (UPDATED FOR ASI & VISION)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const start = Date.now();
    
    // IMAGE HANDLING
    const { message, userId, image } = req.body; 

    if (!message && !image) {
        return res.status(400).json({ success: false, message: "Input missing" });
    }

    const cleanMsg = message ? sanitizeInput(message) : "Image Analysis Request";
    const matchText = cleanMsg.toLowerCase().trim(); 

    // 🧠 Dynamic Threshold Logic
    const wordCount = matchText.split(/\s+/).length;
    const currentThreshold = wordCount < 5 ? SHORT_TEXT_THRESHOLD : BASE_THRESHOLD;

    let replyContent = "";
    let audioUrl = "";
    let source = "TITAN_ASI"; 

    // ========================================================
    // 1️⃣ DB FAQ MATCH (SMART TAG SEARCH)
    // ========================================================
    if (!image) { 
        try {
            console.log(`🔍 [FAQ CHECK] Searching for: "${matchText}" | Req Score: ${currentThreshold}`);

            const faqs = await db.FAQ.findAll({
                where: { status: 'APPROVED' },
                attributes: ['id', 'question', 'answer', 'audioUrl', 'tags']
            });

            if (faqs.length) {
                let bestMatch = { rating: 0, faq: null };

                faqs.forEach(faq => {
                    const qScore = stringSimilarity.compareTwoStrings(matchText, faq.question.toLowerCase());
                    let tScore = 0;
                    let tagsArray = [];
                    
                    if (typeof faq.tags === 'string') {
                        try { tagsArray = JSON.parse(faq.tags); } catch(e) {}
                    } else if (Array.isArray(faq.tags)) {
                        tagsArray = faq.tags;
                    }

                    if (tagsArray.length > 0) {
                        const tagMatch = stringSimilarity.findBestMatch(matchText, tagsArray);
                        tScore = tagMatch.bestMatch.rating;
                    }

                    const finalScore = Math.max(qScore, tScore);

                    if (finalScore > bestMatch.rating) {
                        bestMatch = { rating: finalScore, faq: faq };
                    }
                });

                if (bestMatch.rating >= currentThreshold) { 
                    replyContent = bestMatch.faq.answer;
                    audioUrl = bestMatch.faq.audioUrl || "";
                    source = "DB_FAQ_HIT";
                    console.log(`✅ FAQ Found! Serving from Database.`);
                }
            }
        } catch (err) {
            console.error("🔥 FAQ Search Failed:", err.message);
        }
    }

    // ========================================================
    // 2️⃣ TITAN ASI ENGINE (RAG + VISION)
    // ========================================================
    if (!replyContent) {
        try {
            // ✅ UPDATED: CONTEXT MEMORY FETCHING
            // AI ko pichhle messages bhejne ke liye data fetch kar rahe hain
            let history = [];
            const reqUserId = userId || req.user?.id;

            if (reqUserId) {
                // Fetch last 3 full turns (User + AI) = 3 rows approx if stored together
                // Note: ChatMessage typically stores 1 row per interaction
                const pastMessages = await db.ChatMessage.findAll({
                    where: { userId: reqUserId },
                    order: [['createdAt', 'DESC']], // Latest pehle
                    limit: 3 // Last 3 interactions fetch karenge context ke liye
                });

                // Array reverse karke chronological order (Oldest -> Newest) banayein
                pastMessages.reverse().forEach(msg => {
                    // User ka message
                    history.push({ role: "user", content: msg.message });
                    // Agar AI ka reply database me hai to use bhi add karein
                    if (msg.response) {
                        history.push({ role: "assistant", content: msg.response });
                    }
                });
            }

            if (image) {
                replyContent = await analyzeImageWithAI(image);
                source = "TITAN_VISION";
            } else {
                const currentUser = req.user || { fullName: "Leader", pinLevel: "Associate" };
                // ✅ UPDATED: Passing 'history' to the service
                replyContent = await generateTitanResponse(currentUser, cleanMsg, history);
            }
        } catch (error) {
            console.error("AI Generation Error:", error.message);
            replyContent = "Network issue. Kripya thodi der baad try karein. Jai RCM.";
        }

        // Generate Audio for AI response
        try {
            if (replyContent.length < 600) {
                audioUrl = await generateEdgeAudio(replyContent);
            }
        } catch (e) {
            console.error("Audio Gen Failed:", e.message);
        }
    }

    // ========================================================
    // 3️⃣ RESPONSE
    // ========================================================
    res.status(200).json({
        success: true,
        message: replyContent,
        reply: replyContent,
        audioUrl: audioUrl || "",
        source,
        latency: `${Date.now() - start}ms`
    });

    // Logging...
    setImmediate(async () => {
        try {
            if (userId || req.user?.id) {
                await db.ChatMessage.create({
                    userId: userId || req.user?.id,
                    sender: "USER",
                    message: cleanMsg,
                    response: replyContent,
                    audioUrl,
                    source: source
                });
            }
        } catch (err) { console.error("Log Error:", err.message); }
    });
});

// ============================================================
// 🧑‍💼 ADMIN → CHAT USERS LIST
// ============================================================
const getAllChatUsers = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
        const rows = await db.ChatMessage.findAll({
            attributes: [
                'userId',
                [db.sequelize.fn('MAX', db.sequelize.col('ChatMessage.createdAt')), 'lastMessageAt']
            ],
            group: ['userId'],
            include: [{
                model: db.User,
                as: 'User', 
                attributes: ['id', 'fullName', 'email']
            }],
            order: [[db.sequelize.literal('lastMessageAt'), 'DESC']]
        });

        const users = rows.map(r => {
            if (!r.User) return null;
            const userJson = r.User.toJSON();
            userJson.lastMessageAt = r.getDataValue('lastMessageAt');
            return userJson;
        }).filter(Boolean);

        res.json({ success: true, data: users });
    } catch (error) {
        console.error("Get Users Error:", error.message);
        res.status(500).json({ success: false, message: "Failed to fetch users" });
    }
});

// ============================================================
// 🧑‍💼 ADMIN → CHAT HISTORY
// ============================================================
const getChatHistoryByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const page = Number(req.query.page || 1);
    const limit = 30;
    const offset = (page - 1) * limit;

    res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
    });

    try {
        const messages = await db.ChatMessage.findAll({
            where: { userId },
            order: [['createdAt', 'ASC']],
            limit,
            offset
        });

        res.status(200).json({
            success: true,
            page,
            data: messages
        });
    } catch (error) {
        console.error("History Error:", error.message);
        res.status(500).json({ success: false, message: "Failed to fetch history" });
    }
});

// ============================================================
// 🛡️ ADMIN → ADD SMART RESPONSE
// ============================================================
const addSmartResponse = asyncHandler(async (req, res) => {
    const { question, answer } = req.body;

    if (!question || !answer) {
        return res.status(400).json({ success: false, message: "Missing data" });
    }

    const audioUrl = req.file
        ? await uploadAudioToCloudinary(req.file.buffer, `faq_${Date.now()}`)
        : await generateEdgeAudio(answer);

    await db.FAQ.create({
        question,
        answer,
        audioUrl,
        status: 'APPROVED',
        isUserSubmitted: false
    });

    res.json({ success: true, message: "Smart response saved" });
});

// ============================================================
// 🛡️ ADMIN → UPGRADE FAQ
// ============================================================
const upgradeToPremium = asyncHandler(async (req, res) => {
    const { faqId, answer } = req.body;

    const faq = await db.FAQ.findByPk(faqId);
    if (!faq) {
        return res.status(404).json({ success: false, message: "FAQ not found" });
    }

    const updateData = { status: 'APPROVED' };
    if (answer) updateData.answer = answer;
    
    if (req.file) {
        updateData.audioUrl = await uploadAudioToCloudinary(
            req.file.buffer,
            `upgrade_${faqId}`
        );
    }

    await faq.update(updateData);
    res.json({ success: true, message: "FAQ upgraded" });
});

// ============================================================
// 🔊 DIRECT TTS
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ success: false, message: "Text missing" });
    }

    const audioUrl = await generateEdgeAudio(text);
    res.json({ success: true, audioUrl });
});

// ============================================================
// 📦 EXPORTS
// ============================================================
module.exports = {
    handleChat,
    handleSpeak,
    addSmartResponse,
    upgradeToPremium,
    getAllChatUsers,
    getChatHistoryByUser
};