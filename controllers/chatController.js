/**
 * @file src/controllers/chatController.js
 * @description Logic: DB Audio Priority -> AI Generation -> No DB Save -> Admin Alert.
 * @status Production Ready (Fixed Associations)
 */

const asyncHandler = require('express-async-handler');
const stringSimilarity = require('string-similarity');

const { getAIChatResponse } = require('../services/aiService');
const { generateEdgeAudio } = require('../services/edgeTtsService');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const { db } = require('../config/db');

let { SYSTEM_PROMPT } = require('../utils/prompts');

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
// 🚀 USER → AI CHAT (CORE LOGIC)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const start = Date.now();

    // ✅ CRITICAL: Get userId from Token (req.user) FIRST
    let userId = req.user ? req.user.id : req.body.userId;
    
    // Ensure userId is a valid integer
    userId = userId ? parseInt(userId, 10) : null;

    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message missing" });
    }

    const cleanMsg = sanitizeInput(message);
    const matchText = cleanMsg.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '');

    let replyContent = "";
    let audioUrl = "";
    let source = "AI_LIVE";

    // ========================================================
    // 1️⃣ DB FAQ MATCH (HIGHEST PRIORITY)
    // ========================================================
    try {
        const faqs = await db.FAQ.findAll({
            where: { status: 'APPROVED' },
            attributes: ['question', 'answer', 'audioUrl']
        });

        if (faqs.length) {
            const questions = faqs.map(f => f.question.toLowerCase());
            const match = stringSimilarity.findBestMatch(matchText, questions);

            if (match.bestMatch.rating > 0.75) {
                const faq = faqs[match.bestMatchIndex];
                replyContent = faq.answer;
                
                // Use DB audio only if valid
                if (faq.audioUrl && faq.audioUrl.length > 5) {
                    audioUrl = faq.audioUrl;
                    source = "DB_AUDIO_HIT";
                } else {
                    source = "DB_TEXT_ONLY";
                }
            }
        }
    } catch (err) {
        console.error("FAQ Match Error:", err.message);
    }

    // ========================================================
    // 2️⃣ AI FALLBACK (If DB match failed)
    // ========================================================
    if (!replyContent) {
        try {
            replyContent = await getAIChatResponse([
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: cleanMsg }
            ]);
        } catch {
            replyContent = "Temporary network issue. Please try again.";
        }

        // Generate Audio for AI response
        if (replyContent) {
            try {
                audioUrl = await generateEdgeAudio(replyContent);
            } catch {
                audioUrl = "";
            }
        }
    }

    // ========================================================
    // 3️⃣ SEND RESPONSE TO USER
    // ========================================================
    res.status(200).json({
        success: true,
        message: replyContent,
        reply: replyContent,
        audioUrl: audioUrl || "",
        source,
        latency: `${Date.now() - start}ms`
    });

    // ========================================================
    // 4️⃣ ASYNC LOGGING (DB SAVE)
    // ========================================================
    setImmediate(async () => {
        try {
            // Only save if we have a valid User ID
            if (userId && !isNaN(userId)) {
                await db.ChatMessage.create({
                    userId: userId,
                    sender: "USER",
                    message: cleanMsg,
                    response: replyContent,
                    audioUrl: audioUrl || ""
                });
            } else {
                console.warn(`⚠️ Chat NOT Saved: userId missing. (Token: ${req.user ? 'OK' : 'Missing'})`);
            }

            // Admin Alert for new AI queries
            if (source === "AI_LIVE" && matchText.length > 5) {
                sendAdminAlert(cleanMsg, replyContent).catch(() => {});
            }
        } catch (err) {
            console.error("Chat Log Error:", err.message);
        }
    });
});

// ============================================================
// 🧑‍💼 ADMIN DASHBOARD: GET CHAT USERS
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
// 🧑‍💼 ADMIN DASHBOARD: GET USER HISTORY
// ============================================================
const getChatHistoryByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const page = Number(req.query.page || 1);
    const limit = 30;
    const offset = (page - 1) * limit;

    res.set({ "Cache-Control": "no-store" });

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
// 🛡️ ADMIN: ADD SMART RESPONSE
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
// 🛡️ ADMIN: UPGRADE FAQ
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
// 🔊 DIRECT TTS (Text to Speech)
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