/**
 * @file src/controllers/chatController.js
 * @description Optimized Flow: FAQ Cache -> Titan ASI Engine (Text/Vision) -> Response with imageUrl support
 */

const asyncHandler = require('express-async-handler');
const stringSimilarity = require('string-similarity');

// UPDATED IMPORTS FOR ASI & VISION
const { generateTitanResponse, analyzeImageWithAI, getLastMatchedImageUrl } = require('../services/aiService');
const { generateEdgeAudio } = require('../services/edgeTtsService');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const db = require('../models'); 
const { ChatMessage, FAQ, VoiceResponse, Product } = db;

// ============================================================
// ⚙️ CONSTANTS & CONFIG
// ============================================================
const BASE_THRESHOLD = 0.92; 
const SHORT_TEXT_THRESHOLD = 0.95; 

// ============================================================
// 🟡 ADMIN ALERT WRAPPER (Safe Mode)
// ============================================================
let sendAdminAlert = async () => {};

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
    
    const { message, userId, image } = req.body; 
    const requestingUser = req.user;

    if (!message && !image) {
        return res.status(400).json({ success: false, message: "Input missing" });
    }

    if (requestingUser && requestingUser.role === "USER" && (requestingUser.status !== "active" && requestingUser.status !== "premium")) {
        return res.status(403).json({ 
            success: false, 
            message: "🚫 Access Denied: Please subscribe to use chat features.",
            redirect: "/payment-setup"
        });
    }

    const cleanMsg = message ? sanitizeInput(message) : "Image Analysis Request";
    const matchText = cleanMsg.toLowerCase().trim(); 
    let replyContent = ""; 
    let audioUrl = "";
    let source = "TITAN_ASI"; 

    const CALCULATOR_KEYWORDS = [
        "calculate", "calculator", "income kitna", "business check", "kitna banega",
        "pv calculate", "bonus calculate", "earning check", "earning kitna", "rotyalty"
    ];

    const PV_KEYWORDS = {
        self: ["self pv", "mera pv", "my pv", "self purchase pv"],
        legA: ["leg a pv", "a leg pv", "first leg pv"],
        legB: ["leg b pv", "b leg pv", "second leg pv"]
    };

    const detectAndExtractPvValues = (message) => {
        const lowerCaseMessage = message.toLowerCase();
        let isCalculatorIntent = CALCULATOR_KEYWORDS.some(keyword => lowerCaseMessage.includes(keyword));
        let selfPurchasePv = null;
        let legAPv = null;
        let legBPv = null;

        const extractValue = (keywords) => {
            for (const keyword of keywords) {
                const regex = new RegExp(`${keyword}\\s*(\\d+)`, "i");
                const match = lowerCaseMessage.match(regex);
                if (match && match[1]) {
                    return parseInt(match[1], 10);
                }
            }
            return null;
        };

        selfPurchasePv = extractValue(PV_KEYWORDS.self);
        legAPv = extractValue(PV_KEYWORDS.legA);
        legBPv = extractValue(PV_KEYWORDS.legB);

        if ((selfPurchasePv !== null || legAPv !== null || legBPv !== null) && !isCalculatorIntent) {
             isCalculatorIntent = true;
        }

        return {
            isCalculatorIntent,
            selfPurchasePv,
            legAPv,
            legBPv
        };
    };

    let calculatorData = null;
    if (!image && message) {
        calculatorData = detectAndExtractPvValues(cleanMsg);
        if (calculatorData.isCalculatorIntent) {
            replyContent = JSON.stringify({
                type: "calculator_widget",
                data: {
                    selfPurchasePv: calculatorData.selfPurchasePv,
                    legAPv: calculatorData.legAPv,
                    legBPv: calculatorData.legBPv
                }
            });
            source = "BUSINESS_CALCULATOR_WIDGET";
        }
    }

    if (!calculatorData.isCalculatorIntent) {
        const wordCount = matchText.split(/\s+/).length;
        const currentThreshold = wordCount < 5 ? SHORT_TEXT_THRESHOLD : BASE_THRESHOLD;

        if (!calculatorData.isCalculatorIntent) {
            if (!image) { 
                try {
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
                        }
                    }
                } catch (err) {
                    console.error("🔥 FAQ Search Failed:", err.message);
                }
            }

            if (!replyContent) {
                try {
                    let history = [];
                    const reqUserId = userId || req.user?.id;

                    if (reqUserId) {
                        const pastMessages = await db.ChatMessage.findAll({
                            where: { userId: reqUserId },
                            order: [['createdAt', 'DESC']],
                            limit: 12
                        });

                        pastMessages.reverse().forEach(msg => {
                            history.push({ role: "user", content: msg.message });
                            if (msg.response) {
                                let aiContent = msg.response;
                                try {
                                    const parsed = JSON.parse(msg.response);
                                    if (parsed && parsed.type === 'calculator_widget') {
                                        aiContent = `[System Calculator Widget Triggered]: Self PV: ${parsed.data.selfPurchasePv}, Leg A PV: ${parsed.data.legAPv}, Leg B PV: ${parsed.data.legBPv}`;
                                    }
                                } catch (e) {}
                                history.push({ role: "assistant", content: aiContent });
                            }
                        });
                    }

                    if (image) {
                        replyContent = await analyzeImageWithAI(image);
                        source = "TITAN_VISION";
                    } else {
                        const currentUser = req.user || { fullName: "Leader", pinLevel: "Associate" };
                        replyContent = await generateTitanResponse(currentUser, cleanMsg, history);
                    }
                } catch (error) {
                    console.error("AI Generation Error:", error.message);
                    replyContent = "Network issue. Kripya thodi der baad try karein. Jai RCM.";
                }

                try {
                    if (replyContent.length < 600) {
                        audioUrl = await generateEdgeAudio(replyContent);
                    }
                } catch (e) {
                    console.error("Audio Gen Failed:", e.message);
                }
            }
        }
    }

    res.status(200).json({
        success: true,
        message: replyContent,
        reply: replyContent,
        audioUrl: audioUrl || "",
        source,
        latency: `${Date.now() - start}ms`,
        imageUrl: getLastMatchedImageUrl() || null,
        ...(source === "BUSINESS_CALCULATOR_WIDGET" && {
            type: "calculator_widget",
            data: JSON.parse(replyContent).data
        })
    });

    setImmediate(async () => {
        try {
            const currentUserId = userId || req.user?.id;
            if (currentUserId) {
                await db.ChatMessage.create({
                    userId: currentUserId,
                    sender: 'user',
                    message: cleanMsg,
                    isAudio: false,
                    metadata: { source: 'USER_INPUT' }
                });

                await db.ChatMessage.create({
                    userId: currentUserId,
                    sender: 'ai',
                    message: replyContent,
                    isAudio: (audioUrl !== ''),
                    metadata: {
                        audioUrl: audioUrl || null,
                        source: source,
                        latency: `${Date.now() - start}ms`,
                        imageUrl: getLastMatchedImageUrl() || null
                    }
                });
            }
        } catch (err) { console.error("Log Error:", err.message); }
    });
});

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

const getChatHistoryByUser = asyncHandler(async (req, res) => {
    const { userId: userIdParam } = req.params;
    const userId = parseInt(userIdParam, 10);

    if (isNaN(userId)) {
        return res.status(400).json({ success: false, message: "Invalid User ID" });
    }

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

const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ success: false, message: "Text missing" });
    }

    const audioUrl = await generateEdgeAudio(text);
    res.json({ success: true, audioUrl });
});

module.exports = {
    handleChat,
    handleSpeak,
    addSmartResponse,
    upgradeToPremium,
    getAllChatUsers,
    getChatHistoryByUser
};
