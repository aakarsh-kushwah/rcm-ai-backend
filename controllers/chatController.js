const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
// ✅ Paath (path) ko './' se '../' karein (agar 'utils' folder backend root par hai)
const { SYSTEM_PROMPT } = require('../utils/prompts'); 
const asyncHandler = require('express-async-handler');

// ============================================================
// 🔹 Handle User Chat (AI)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, mode, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message content is required." });
    }

    // 1️⃣ Construct messages array
    // Pichhli chat history (agar hai) + naya system prompt + naya user message
    const groqMessages = [
        { role: "system", content: SYSTEM_PROMPT }, // Naya RCM prompt
        // TODO: Yahaan chatHistory (agar hai) ko map karke add karein
        { role: "user", content: `(Current Mode: ${mode || 'General'}) ${message}` },
    ];

    // 2️⃣ Get response from AI service
    // aiService ab hamesha ek JSON *string* return karega
    const replyString = await getAIChatResponse(groqMessages);

    // 3️⃣ Reply ko parse karein
    let replyContent = ""; // Database mein save karne ke liye
    let jsonReply = null; // Client ko bhejne ke liye

    try {
        // Koshish karein ki reply ko JSON mein parse karein
        jsonReply = JSON.parse(replyString);
        
        // Check karein ki 'content' hai ya nahi
        if (jsonReply && typeof jsonReply.content === 'string') {
            replyContent = jsonReply.content;
        } else if (jsonReply && typeof jsonReply.text === 'string') {
            // Agar galti se { "text": "..." } format aata hai
            replyContent = jsonReply.text;
            jsonReply = { type: 'text', content: replyContent }; // Isse normalize karein
        } else {
             // Agar JSON valid hai lekin 'content' nahi hai
            replyContent = replyString; // Poora string save karein
            jsonReply = { type: 'text', content: replyString };
        }

    } catch (e) {
        // Agar reply JSON nahi tha (sirf text tha)
        replyContent = replyString; // Raw string save karein
        jsonReply = { type: 'text', content: replyString };
    }

    // 4️⃣ Save chat history (ab 'replyContent' ka istemaal karein)
    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            // ✅ --- YEH HAI MUKHYA FIX (PART 2) ---
            // Ab hum database mein saaf text save kar rahe hain
            { userId, sender: "BOT", message: replyContent }, 
            // --- FIX ENDS ---
H       ]);
    }

    // 5️⃣ Send reply
    // 'jsonReply' hamesha ek valid object hoga { type: ..., content: ... }
    res.status(200).json({ success: true, reply: jsonReply });

    // try/catch ki zaroorat nahi kyunki asyncHandler errors ko pakad lega
});


// ============================================================
// 🔹 Admin: Get All Chats Grouped by User
// ============================================================
const getAllChats = asyncHandler(async (req, res) => {
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
H     });
    });

    res.status(200).json({ success: true, data: chatsByUser });
});

// ✅ Calculator code hata diya gaya hai
module.exports = { handleChat, getAllChats };