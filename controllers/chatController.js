// backend/controllers/chatController.js
const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
// ✅ Naye "Master Prompt" ko import karein (Sirf ek)
const { MASTER_PROMPT } = require('../utils/prompts'); 

// ============================================================
// 🔹 1. Handle User Chat (AI) - (Updated)
// ============================================================
const handleChat = async (req, res) => {
    // ❌ 'mode' ko hata diya gaya hai
    const { message } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
        return res
            .status(400)
            .json({ success: false, message: "Message content cannot be empty." });
    }

    try {
        // 1️⃣ Hamesha "Master Prompt" ka istemal karein
        const systemPrompt = MASTER_PROMPT;

        const groqMessages = [
            { role: "system", content: systemPrompt }, 
            { role: "user", content: message },
        ];

        // 2️⃣ Get response from AI service
        const replyFromAI = await getAIChatResponse(groqMessages);

        let reply;
        
        // 3️⃣ AI ka jawab JSON hai ya Text, yeh check karein
        try {
            // (Jaise {"type": "calculator", ...})
            reply = JSON.parse(replyFromAI);
        } catch (e) {
            // (Yeh ek aam text message hai)
            reply = { type: "text", content: replyFromAI };
        }

        // 4️⃣ Save chat history
        if (userId) {
            await db.ChatMessage.bulkCreate([
                { userId, sender: "USER", message },
                // Hum AI ke raw (asli) jawab ko save karte hain (JSON ya text)
                { userId, sender: "BOT", message: JSON.stringify(reply) }, 
            ]);
        }

        // 5️⃣ Send reply
        res.status(200).json({ success: true, reply });
    } catch (error) {
        console.error("❌ Chat Error:", error);
        res.status(500).json({
            success: false,
            message: error.message || "An unexpected error occurred during AI processing.",
        });
    }
};

// ============================================================
// 🔹 2. Commission Calculator (Ismein koi badlaav nahin)
// ============================================================
const commissionSlabs = [
    { bv: 350000, percent: 0.22 },   // 22%
    { bv: 260000, percent: 0.195 },  // 19.5%
    { bv: 170000, percent: 0.17 },   // 17%
    { bv: 115000, percent: 0.145 },  // 14.5%
    { bv: 70000,  percent: 0.12 },   // 12%
    { bv: 40000,  percent: 0.095 },  // 9.5%
    { bv: 20000,  percent: 0.07 },   // 7%
    { bv: 10000,  percent: 0.045 },  // 4.5%
    { bv: 5000,   percent: 0.02 },   // 2%
    { bv: 0,      percent: 0.00 }    // 0%
];

const getPercentage = (bv) => {
    const numericBV = parseFloat(bv);
    if (isNaN(numericBV)) return 0;
    for (const slab of commissionSlabs) {
        if (numericBV >= slab.bv) return slab.percent;
    }
    return 0; 
};

const handleCalculate = (req, res) => {
    const { selfBV, legs } = req.body;
    const userId = req.user ? req.user.id : null;

    try {
        const numSelfBV = parseFloat(selfBV) || 0;
        const numLegsBV = Array.isArray(legs) ? legs.map(leg => parseFloat(leg.bv) || 0) : [];

        const totalLegsBV = numLegsBV.reduce((acc, bv) => acc + bv, 0);
        const totalBV = numSelfBV + totalLegsBV;
        const userPercent = getPercentage(totalBV);

        let calculations = [];
        let totalCommission = 0;

        const selfCommission = numSelfBV * userPercent;
        totalCommission += selfCommission;
        calculations.push(`Self Commission: ${numSelfBV.toLocaleString('en-IN')} BV @ ${userPercent * 100}% = ₹${selfCommission.toFixed(2)}`);

        numLegsBV.forEach((legBV, index) => {
            if (legBV > 0) { 
                const legPercent = getPercentage(legBV);
                const differentialPercent = userPercent - legPercent;
                
                if (differentialPercent > 0) {
                    const legCommission = legBV * differentialPercent;
                    totalCommission += legCommission;
                    calculations.push(`Leg ${String.fromCharCode(65 + index)} Commission: ${legBV.toLocaleString('en-IN')} BV @ ${differentialPercent * 100}% (Diff: ${userPercent * 100}% - ${legPercent * 100}%) = ₹${legCommission.toFixed(2)}`);
                } else {
                    calculations.push(`Leg ${String.fromCharCode(65 + index)}: No commission (Leg slab ${legPercent*100}% is >= your slab)`);
                }
            }
        });

        const resultString = `
Here is your Performance Bonus calculation:
---
**Your Total BV:** ${totalBV.toLocaleString('en-IN')}
**Your Slab:** ${userPercent * 100}%
---
${calculations.join('\n')}
---
**Total Estimated Commission:** ₹${totalCommission.toFixed(2)}
*(Note: This is an estimate based on Performance Bonus slabs only.)*
        `;

        const reply = { type: 'text', content: resultString };
        
        if(userId) {
            const userMessage = `Calculation for: Self BV: ${numSelfBV}, Legs: ${numLegsBV.join(', ')}`;
             db.ChatMessage.bulkCreate([
                { userId, sender: "USER", message: userMessage },
                { userId, sender: "BOT", message: JSON.stringify(reply) }, 
            ]);
        }

        res.status(200).json({ success: true, reply });

    } catch (error) {
        console.error("❌ Calculation Error:", error);
        res.status(500).json({
            success: false,
            message: "Calculation failed.",
            reply: { type: 'text', content: "Sorry, I couldn't calculate the commission due to an error."}
        });
    }
};

// ============================================================
// 🔹 3. Admin: Get All Chats (Ismein koi badlaav nahin)
// ============================================================
const getAllChats = async (req, res) => {
    try {
        const allMessages = await db.ChatMessage.findAll({
            include: [
                {
                    model: db.User,
                    attributes: ["email"],
                },
            ],
            order: [["createdAt", "DESC"]],
        });

        const chatsByUser = {};
        allMessages.forEach((msg) => {
            const email = msg.User ? msg.User.email : "Unknown User";
            if (!chatsByUser[email]) chatsByUser[email] = [];
            
            let messageContent = msg.message;
            try {
                // Yeh '{"type":"text","content":"..."}' jaise JSON ko saaf text mein badlega
                const parsed = JSON.parse(msg.message);
                if (parsed && parsed.content) {
                    messageContent = parsed.content.substring(0, 100) + (parsed.content.length > 100 ? '...' : '');
                }
            } catch (e) {
                // yeh pehle se hi saaf text hai (jaise purane user messages)
            }
            
            chatsByUser[email].push({
                sender: msg.sender,
                message: messageContent,
                createdAt: msg.createdAt,
            });
        });

        res.status(200).json({ success: true, data: chatsByUser });
    } catch (error) {
        console.error("❌ Admin Chat Fetch Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to retrieve chat history.",
            error: error.message,
        });
    }
};

module.exports = { handleChat, getAllChats, handleCalculate };