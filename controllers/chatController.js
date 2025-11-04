// backend/controllers/chatController.js
const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT } = require('../utils/prompts'); 

// ============================================================
// 🔹 1. Helper Function: Emojis को हटाने के लिए
// (यह 'Incorrect string value' वाले एरर को रोकता है)
// ============================================================
const removeEmojis = (str) => {
  if (!str) return '';
  // यह regex (रेगेक्स) ज़्यादातर Emojis और खास सिंबल को पकड़ लेता है
  return str.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '').trim();
};


// ============================================================
// 🔹 2. Handle User Chat (AI) - (Updated)
// ============================================================
const handleChat = async (req, res) => {
    const { message } = req.body; 
    const userId = req.user ? req.user.id : null;
    let replyFromAI; // AI का जवाब
    let replyObject; // AI का JSON ऑब्जेक्ट

    if (!message) {
        return res.status(400).json({ success: false, message: "Message content cannot be empty." });
    }

    try {
        // 1️⃣ AI का जवाब लाएँ
        const systemPrompt = MASTER_PROMPT;
        let chatHistory = [];
        
        // पिछला इतिहास (Previous History) लाएँ
        if (userId) {
             const history = await db.ChatMessage.findAll({
                where: { userId },
                order: [['createdAt', 'DESC']],
                limit: 6 
             });
             history.reverse();
             
             for (const msg of history) {
                if (msg.sender === 'USER') {
                    chatHistory.push({ role: 'user', content: msg.message });
                } else {
                    try {
                         const botReply = JSON.parse(msg.message);
                         if (botReply.type === 'text') {
                             chatHistory.push({ role: 'assistant', content: botReply.content });
                         }
                    } catch (e) { 
                        chatHistory.push({ role: 'assistant', content: msg.message });
                    }
                }
             }
        }
        
        const groqMessages = [
            { role: "system", content: systemPrompt }, 
            ...chatHistory,
            { role: "user", content: message },
        ];
        
        replyFromAI = await getAIChatResponse(groqMessages); // यह हमेशा स्ट्रिंग देगा
        
        // 2️⃣ जवाब को Parse (पार्स) करें
        try {
            replyObject = JSON.parse(replyFromAI); // (e.g., {"type": "calculator"})
        } catch (e) {
            replyObject = { type: "text", content: replyFromAI }; // (e.g., "Hello")
        }

        // 3️⃣ ✅ डेटाबेस में सेव करें (Emojis हटाकर)
        if (userId) {
            // यूज़र का मैसेज (Emojis हटाकर)
            const dbSafeUserMessage = removeEmojis(message);
            
            // बॉट का जवाब (Emojis हटाकर)
            let dbSafeBotMessage;
            if (replyObject.type === 'text') {
                 dbSafeBotMessage = JSON.stringify({
                    type: 'text',
                    content: removeEmojis(replyObject.content) // ✅ Emojis को यहाँ साफ़ करें
                 });
            } else {
                 dbSafeBotMessage = JSON.stringify(replyObject); // Calculator/Video (इसमें Emojis नहीं होते)
            }
            
            await db.ChatMessage.bulkCreate([
                { userId, sender: "USER", message: dbSafeUserMessage },
                { userId, sender: "BOT", message: dbSafeBotMessage }, 
            ]);
        }

        // 4️⃣ यूज़र को जवाब भेजें (Emojis के साथ)
        res.status(200).json({ success: true, reply: replyObject });

    } catch (error) {
        // --- (अगर 'bulkCreate' या कुछ और फेल होता है) ---
        console.error("❌ Chat Controller Error:", error);
        
        const errorMessage = { 
            type: 'text', 
            content: error.message || "An unexpected error occurred." 
        };
        
        res.status(500).json({
            success: false,
            reply: errorMessage // यूज़र को एरर दिखाएँ
        });
    }
};

// ============================================================
// 🔹 3. Commission Calculator (Ismein koi badlaav nahin)
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

        // Emojis (इमोजी) यहाँ से भी हटा दें
        const resultString = `
Here is your Performance Bonus calculation:
---
Your Total BV: ${totalBV.toLocaleString('en-IN')}
Your Slab: ${userPercent * 100}%
---
${calculations.join('\n')}
---
Total Estimated Commission: Rs ${totalCommission.toFixed(2)}
(Note: This is an estimate based on Performance Bonus slabs only.)
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
// 🔹 4. Admin: Get All Chats (Updated)
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
                // यह '{"type":"text","content":"..."}' jaise JSON ko saaf text mein badlega
                const parsed = JSON.parse(msg.message);
                if (parsed && parsed.content) {
                    messageContent = parsed.content.substring(0, 100) + (parsed.content.length > 100 ? '...' : '');
                } else if (parsed && parsed.type) {
                    messageContent = `[${parsed.type} card]`; // (e.g., [calculator card])
                }
            } catch (e) {
                // yeh pehle se hi saaf text hai
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