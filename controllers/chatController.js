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
const db = require('../models'); // ✅ यह सही है
const { ChatMessage, FAQ, VoiceResponse, Product } = db; // Destructure here
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
// ============================================================
// 🚀 USER → AI CHAT (UPDATED: DEBUGGING & TAG SUPPORT)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const start = Date.now();
    
    // IMAGE HANDLING
    const { message, userId, image } = req.body; 

    if (!message && !image) {
        return res.status(400).json({ success: false, message: "Input missing" });
    }

    const cleanMsg = message ? sanitizeInput(message) : "Image Analysis Request";
    const matchText = cleanMsg.toLowerCase().trim(); // Special chars rehne dein matching ke liye

    let replyContent = "";
    let audioUrl = "";
    let source = "TITAN_ASI"; 

    // ========================================================
    // 1️⃣ DB FAQ MATCH (SMART TAG SEARCH)
    // ========================================================
    if (!image) { 
        try {
            console.log(`🔍 [FAQ CHECK] Searching for: "${matchText}"`);

            const faqs = await db.FAQ.findAll({
                where: { status: 'APPROVED' },
                attributes: ['id', 'question', 'answer', 'audioUrl', 'tags']
            });

            console.log(`📊 [FAQ CHECK] Loaded ${faqs.length} FAQs from DB.`);

            if (faqs.length) {
                let bestMatch = { rating: 0, target: null };

                // Har FAQ ko check karo
                faqs.forEach(faq => {
                    // 1. Main Question match karo
                    const qScore = stringSimilarity.compareTwoStrings(matchText, faq.question.toLowerCase());
                    
                    // 2. Tags match karo (Agar tags array hai)
                    let tScore = 0;
                    let tagsArray = [];
                    
                    // Tags parsing logic (JSON or Array)
                    if (typeof faq.tags === 'string') {
                        try { tagsArray = JSON.parse(faq.tags); } catch(e) {}
                    } else if (Array.isArray(faq.tags)) {
                        tagsArray = faq.tags;
                    }

                    if (tagsArray.length > 0) {
                        const tagMatch = stringSimilarity.findBestMatch(matchText, tagsArray);
                        tScore = tagMatch.bestMatch.rating;
                    }

                    // Jo score bada ho, use lo
                    const finalScore = Math.max(qScore, tScore);

                    // Debug Log per FAQ (Optional: Sirf high score dikhayein)
                    if (finalScore > 0.3) {
                        console.log(`   👉 Match Attempt: ID ${faq.id} | Score: ${finalScore.toFixed(2)}`);
                    }

                    if (finalScore > bestMatch.rating) {
                        bestMatch = { rating: finalScore, faq: faq };
                    }
                });

                console.log(`🏆 [BEST MATCH] Score: ${bestMatch.rating.toFixed(2)}`);

                // THRESHOLD: 0.4 (40% match is enough for search)
                if (bestMatch.rating > 0.40) { 
                    replyContent = bestMatch.faq.answer;
                    audioUrl = bestMatch.faq.audioUrl || "";
                    source = "DB_FAQ_HIT";
                    console.log("✅ FAQ Found! Serving from Database.");
                } else {
                    console.log("❌ No strong match found. Switching to AI.");
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
            if (image) {
                replyContent = await analyzeImageWithAI(image);
                source = "TITAN_VISION";
            } else {
                const currentUser = req.user || { fullName: "Leader", pinLevel: "Associate" };
                replyContent = await generateTitanResponse(currentUser, cleanMsg);
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
// 🧑‍💼 ADMIN → CHAT USERS LIST (UNCHANGED)
// ============================================================
const getAllChatUsers = asyncHandler(async (req, res) => {
    // Prevent caching for real-time admin view
    res.set("Cache-Control", "no-store");

    try {
        const rows = await db.ChatMessage.findAll({
            attributes: [
                'userId',
                // ✅ FIX: Get the LATEST message time for sorting
                [db.sequelize.fn('MAX', db.sequelize.col('ChatMessage.createdAt')), 'lastMessageAt']
            ],
            group: ['userId'], // Group by User
            include: [{
                model: db.User,
                as: 'User', 
                attributes: ['id', 'fullName', 'email']
            }],
            // ✅ FIX: Order by the calculated 'lastMessageAt'
            order: [[db.sequelize.literal('lastMessageAt'), 'DESC']]
        });

        // Filter valid users
        const users = rows.map(r => {
            if (!r.User) return null;
            // Optional: Attach last message time to user object for frontend
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
// 🧑‍💼 ADMIN → CHAT HISTORY (UNCHANGED)
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
// 🛡️ ADMIN → ADD SMART RESPONSE (UNCHANGED)
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
// 🛡️ ADMIN → UPGRADE FAQ (UNCHANGED)
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
// 🔊 DIRECT TTS (UNCHANGED)
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