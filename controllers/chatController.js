const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
// ✅ पाथ को './' से '../' में बदल दिया गया है
const { SYSTEM_PROMPT } = require('../utils/prompts'); 

// ============================================================
// 🔹 Handle User Chat (AI)
// ============================================================
const handleChat = async (req, res) => {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
    const { message, mode } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
    }

    try {
        // 1️⃣ Construct messages array
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        const groqMessages = [
            { role: "system", content: SYSTEM_PROMPT }, // ✅ अपडेटेड प्रॉम्प्ट
            { role: "user", content: `(Current Mode: ${mode || 'General'}) ${message}` }, // ✅ मोड को मैसेज के साथ भेजें
        ];

        // 2️⃣ Get response from AI service
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        const reply = await getAIChatResponse(groqMessages);

        // 3️⃣ Save chat history
        if (userId) {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
            await db.ChatMessage.bulkCreate([
                { userId, sender: "USER", message },
                { userId, sender: "BOT", message: reply }, 
            ]);
        }

        // 4️⃣ Send reply
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        try {
            // कोशिश करें कि जवाब को JSON में पार्स करें
            const jsonReply = JSON.parse(reply);
            res.status(200).json({ success: true, reply: jsonReply });
        } catch (e) {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
            res.status(200).json({ success: true, reply: { type: 'text', content: reply } });
        }

    } catch (error) {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        res.status(500).json({
            success: false,
            message: error.message || "An unexpected error occurred during AI processing.",
        });
    }
};

// ============================================================
// ✅ --- 2. नया फ़ंक्शन: कमीशन कैलकुलेटर ---
// ... (बाकी का कोड जैसा था वैसा ही है) ...
// ============================================================

// आपकी इमेज से लिए गए कमीशन स्लैब
const commissionSlabs = [
// ... (बाकी का कोड जैसा था वैसा ही है) ...
    { bv: 350000, percent: 0.22 },   // 22%
    { bv: 260000, percent: 0.195 },  // 19.5%
// ... (बाकी का कोड जैसा था वैसा ही है) ...
    { bv: 5000,   percent: 0.02 },   // 2%
    { bv: 0,      percent: 0.00 }    // 0% (5000 से कम)
];

// Helper: BV के हिसाब से % स्लैब निकालता है
// ... (बाकी का कोड जैसा था वैसा ही है) ...
const getPercentage = (bv) => {
    for (const slab of commissionSlabs) {
        if (bv >= slab.bv) {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        }
    }
    return 0; // 5000 BV से कम
};

const handleCalculate = (req, res) => {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
    const { selfBV, legs } = req.body;
    const userId = req.user ? req.user.id : null;

    try {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        const numSelfBV = parseFloat(selfBV) || 0;
        // [{bv: "10000"}, {bv: ""}] को [10000, 0] में बदलें
        const numLegsBV = legs.map(leg => parseFloat(leg.bv) || 0);

        // 1. कुल BV और यूज़र का % निकालें
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        const totalLegsBV = numLegsBV.reduce((acc, bv) => acc + bv, 0);
        const totalBV = numSelfBV + totalLegsBV;
        const userPercent = getPercentage(totalBV);

        let calculations = [];
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        let totalCommission = 0;

        // 2. खुद की खरीद पर कमीशन
        const selfCommission = numSelfBV * userPercent;
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        calculations.push(`Self Commission: ${numSelfBV.toLocaleString('en-IN')} BV @ ${userPercent * 100}% = ₹${selfCommission.toFixed(2)}`);

        // 3. सभी Legs पर डिफ्रेंशियल कमीशन
        numLegsBV.forEach((legBV, index) => {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
            const legPercent = getPercentage(legBV);
            const differentialPercent = userPercent - legPercent;
            
            if (differentialPercent > 0.001) { // फ्लोटिंग पॉइंट एरर से बचने के लिए
// ... (बाकी का कोड जैसा था वैसा ही है) ...
                totalCommission += legCommission;
                calculations.push(`Leg ${String.fromCharCode(65 + index)} Commission: ${legBV.toLocaleString('en-IN')} BV @ ${differentialPercent.toFixed(3) * 100}% (Diff: ${userPercent * 100}% - ${legPercent * 100}%) = ₹${legCommission.toFixed(2)}`);
            } else {
                 calculations.push(`Leg ${String.fromCharCode(65 + index)}: No commission (Leg slab @ ${legPercent*100}% is too high)`);
// ... (बाकी का कोड जैसा था वैसा ही है) ...
            }
        });

        // 4. फ़ाइनल रिजल्ट स्ट्रिंग बनाएँ
// ... (बाकी का कोड जैसा था वैसा ही है) ...
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

        // 5. जवाब वापस भेजें
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        const reply = { type: 'text', content: resultString };
        
        // (वैकल्पिक) कैलकुलेशन को डेटाबेस में सेव करें
        if(userId) {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
            const userMessage = `Calculation for: Self BV: ${numSelfBV}, Legs: ${numLegsBV.join(', ')}`;
             db.ChatMessage.bulkCreate([
                { userId, sender: "USER", message: userMessage },
                { userId, sender: "BOT", message: resultString },
            ]);
        }

        res.status(200).json({ success: true, reply });

    } catch (error) {
// ... (बाकी का कोड जैसा था वैसा ही है) ...
        res.status(500).json({
            success: false,
            message: "Calculation failed.",
            reply: { type: 'text', content: "Sorry, I couldn't calculate the commission due to an error."}
        });
    }
};

// ============================================================
// 🔹 Admin: Get All Chats Grouped by User
// ============================================================
const getAllChats = async (req, res) => {
  try {
    // Fetch chat messages with associated user email
    const allMessages = await db.ChatMessage.findAll({
      include: [
        {
          model: db.User,
          attributes: ["email"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    // Group messages by user email
    const chatsByUser = {};
    allMessages.forEach((msg) => {
      const email = msg.User ? msg.User.email : "Unknown User";
      if (!chatsByUser[email]) chatsByUser[email] = [];
      chatsByUser[email].push({
        sender: msg.sender,
        message: msg.message,
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

