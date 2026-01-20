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
const handleChat = asyncHandler(async (req, res) => {
    const start = Date.now();
    
    // IMAGE HANDLING: Ab 'image' parameter bhi accept hoga
    const { message, userId, image } = req.body; 

    // Validation: Message ya Image me se koi ek hona chahiye
    if (!message && !image) {
        return res.status(400).json({ success: false, message: "Input missing (Text or Image required)" });
    }

    // Input Sanitization
    const cleanMsg = message ? sanitizeInput(message) : "Image Analysis Request";
    const matchText = cleanMsg.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '');

    let replyContent = "";
    let audioUrl = "";
    let source = "TITAN_ASI"; // Default Source

    // ========================================================
    // 1️⃣ DB FAQ MATCH (HIGHEST PRIORITY - TEXT ONLY)
    // ========================================================
    // Vision request ke liye FAQ check nahi karenge
    if (!image) { 
        try {
            const faqs = await db.FAQ.findAll({
                where: { status: 'APPROVED' },
                attributes: ['question', 'answer', 'audioUrl']
            });

            if (faqs.length) {
                const questions = faqs.map(f => f.question.toLowerCase());
                const match = stringSimilarity.findBestMatch(matchText, questions);

                if (match.bestMatch.rating > 0.80) { // Accuracy increased to 80%
                    const faq = faqs[match.bestMatchIndex];
                    replyContent = faq.answer;
                    audioUrl = faq.audioUrl || "";
                    source = faq.audioUrl ? "DB_AUDIO_HIT" : "DB_TEXT_ONLY";
                }
            }
        } catch (err) {
            console.error("FAQ Match Error:", err.message);
        }
    }

    // ========================================================
    // 2️⃣ TITAN ASI ENGINE (RAG + VISION)
    // ========================================================
    if (!replyContent) {
        try {
            if (image) {
                // 👁️ VISION MODE
                replyContent = await analyzeImageWithAI(image);
                source = "TITAN_VISION";
            } else {
                // 🧠 ASI TEXT MODE (Database Connected)
                // req.user pass kar rahe hain taaki Personalization mile (Pin Level etc.)
                const currentUser = req.user || { fullName: "Leader", pinLevel: "Associate" };
                replyContent = await generateTitanResponse(currentUser, cleanMsg);
            }
        } catch (error) {
            console.error("AI Generation Error:", error.message);
            replyContent = "Network issue. Kripya thodi der baad try karein. Jai RCM.";
        }

        // 🔊 GENERATE AUDIO (Only if not from DB Cache)
        try {
            // Limit audio generation for very long texts to save resources
            if (replyContent.length < 600) {
                audioUrl = await generateEdgeAudio(replyContent);
            }
        } catch (e) {
            console.error("Audio Gen Failed:", e.message);
            audioUrl = ""; // Fail silently, text will still go
        }
    }

    // ========================================================
    // 3️⃣ RESPONSE SENDING
    // ========================================================
    res.status(200).json({
        success: true,
        message: replyContent, // Legacy support ke liye
        reply: replyContent,
        audioUrl: audioUrl || "",
        source,
        latency: `${Date.now() - start}ms`
    });

    // ========================================================
    // 4️⃣ ASYNC LOGGING + ADMIN ALERT (BACKGROUND)
    // ========================================================
    setImmediate(async () => {
        try {
            if (userId || req.user?.id) {
                await db.ChatMessage.create({
                    userId: userId || req.user?.id,
                    sender: "USER",
                    message: cleanMsg, // Image ho to "Image Analysis Request" save hoga
                    response: replyContent,
                    audioUrl,
                    source: source // Log source clearly
                });
            } else {
                console.warn(`⚠️ Chat NOT Saved: userId missing. (Token: ${req.user ? 'OK' : 'Missing'})`);
            }

            // Alert Admin only for LIVE AI (Not cached answers)
            if ((source === "TITAN_ASI" || source === "TITAN_VISION") && matchText.length > 5) {
                sendAdminAlert(`[${source}] ${cleanMsg}`, replyContent).catch(() => {});
            }
        } catch (err) {
            console.error("Chat Log Error:", err.message);
        }
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