const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
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
    // Pehle system prompt rakhein
    let groqMessages = [
        { role: "system", content: SYSTEM_PROMPT } 
    ];

    // ✅ --- YEH HAI MUKHYA FIX (PART 1) ---
    // Agar chatHistory hai aur ek array hai, toh usse (spread operator se) add karein
    // Frontend se { role: 'assistant', ... } aa raha hai, jo Groq ke liye perfect hai
    if (chatHistory && Array.isArray(chatHistory)) {
        // Hum poori history bhej rahe hain, pehla message skip nahi kar rahe
        groqMessages = [...groqMessages, ...chatHistory];
    }
    // --- FIX ENDS ---

    // Aakhiri message hamesha user ka naya message hona chahiye
    groqMessages.push({ 
        role: "user", 
        content: `(Current Mode: ${mode || 'General'}) ${message}` 
    });
    
    // 2️⃣ Get response from AI service
    const replyString = await getAIChatResponse(groqMessages);

    // 3️⃣ Reply ko parse karein
    let replyContent = ""; // Database mein save karne ke liye
    let jsonReply = null; // Client ko bhejne ke liye

    try {
        jsonReply = JSON.parse(replyString);
        
        if (jsonReply && typeof jsonReply.content === 'string') {
            replyContent = jsonReply.content;
        } else if (jsonReply && typeof jsonReply.text === 'string') {
            replyContent = jsonReply.text;
            jsonReply = { type: 'text', content: replyContent };
        } else {
            replyContent = replyString;
            jsonReply = { type: 'text', content: replyString };
        }
    } catch (e) {
        replyContent = replyString;
        jsonReply = { type: 'text', content: replyString };
    }

    // 4️⃣ Save chat history
    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    // 5️⃣ Send reply
    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 Admin: Get All Chats Grouped by User
// ============================================================
const getAllChats = asyncHandler(async (req, res) => {
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
      chatsByUser[email].push({
        sender: msg.sender,
        message: msg.message,
        createdAt: msg.createdAt,
      });
    });

    res.status(200).json({ success: true, data: chatsByUser });
});

// ✅ Calculator code yahaan se hata diya gaya hai
module.exports = { handleChat, getAllChats };