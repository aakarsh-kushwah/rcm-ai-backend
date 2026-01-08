/**
 * @file chatController.js
 * @description DB Audio Priority → AI → No DB Pollution → Admin Alert
 */

const asyncHandler = require('express-async-handler');
const stringSimilarity = require('string-similarity');

const { getAIChatResponse } = require('../services/aiService');
const { generateEdgeAudio } = require('../services/edgeTtsService');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const { db } = require('../config/db');

let { SYSTEM_PROMPT } = require('../utils/prompts');

// ============================================================
// 🟡 ADMIN ALERT (UNCHANGED – REQUIRED)
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
// 🚀 USER → AI CHAT
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const start = Date.now();
    const { message, userId } = req.body;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message missing" });
    }

    const cleanMsg = sanitizeInput(message);
    const matchText = cleanMsg
        .toLowerCase()
        .replace(/[^\w\s\u0900-\u097F]/gi, '');

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
                audioUrl = faq.audioUrl || "";
                source = faq.audioUrl ? "DB_AUDIO_HIT" : "DB_TEXT_ONLY";
            }
        }
    } catch (err) {
        console.error("FAQ Match Error:", err.message);
    }

    // ========================================================
    // 2️⃣ AI FALLBACK
    // ========================================================
    if (!replyContent) {
        try {
            replyContent = await getAIChatResponse([
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: cleanMsg }
            ]);
        } catch {
            replyContent = "Temporary network issue.";
        }

        try {
            audioUrl = await generateEdgeAudio(replyContent);
        } catch {
            audioUrl = "";
        }
    }

    // ========================================================
    // 3️⃣ RESPONSE
    // ========================================================
    res.status(200).json({
        success: true,
        message: replyContent,
        reply: replyContent,
        audioUrl,
        source,
        latency: `${Date.now() - start}ms`
    });

    // ========================================================
    // 4️⃣ ASYNC LOGGING + ADMIN ALERT
    // ========================================================
    setImmediate(async () => {
        try {
            if (userId) {
                await db.ChatMessage.create({
                    userId,
                    sender: "USER",
                    message: cleanMsg,
                    response: replyContent,
                    audioUrl
                });
            }

            if (source === "AI_LIVE" && matchText.length > 5) {
                sendAdminAlert(cleanMsg, replyContent)
                    .catch(() => {});
            }
        } catch (err) {
            console.error("Chat Log Error:", err.message);
        }
    });
});

// ============================================================
// 🧑‍💼 ADMIN → CHAT USERS LIST
// ============================================================
const getAllChatUsers = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");

    const rows = await db.ChatMessage.findAll({
        attributes: ['userId'],
        group: ['userId'],
        include: [{
            model: db.User,
            attributes: ['id', 'fullName', 'email']
        }],
        order: [['createdAt', 'DESC']]
    });

    const users = rows.map(r => r.User).filter(Boolean);
    res.json({ success: true, data: users });
});

// ============================================================
// 🧑‍💼 ADMIN → CHAT HISTORY (PAGINATED)
// ============================================================
const getChatHistoryByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const page = Number(req.query.page || 1);
    const limit = 30;
    const offset = (page - 1) * limit;

    // 🚫 STOP 304 CACHE
    res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
    });

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

    // 🔥 ADMIN CHAT VIEW
    getAllChatUsers,
    getChatHistoryByUser
};
