// backend/controllers/chatController.js
const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');

// ✅ System Prompt (for consistent AI behavior)
const SYSTEM_PROMPT =
  "You are the RCM AI assistant. Provide concise and accurate answers related to RCM products, business, and leader information. Maintain a helpful and professional tone.";

// ============================================================
// 🔹 Handle User Chat
// ============================================================
const handleChat = async (req, res) => {
  const { message } = req.body;
  const userId = req.user ? req.user.id : null;

  if (!message) {
    return res
      .status(400)
      .json({ success: false, message: "Message content cannot be empty." });
  }

  try {
    // 1️⃣ Construct messages array
    const groqMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: message },
    ];

    // 2️⃣ Get response from AI service
    const reply = await getAIChatResponse(groqMessages);

    // 3️⃣ Save chat history if user is logged in
    if (userId) {
      await db.ChatMessage.bulkCreate([
        { userId, sender: "USER", message },
        { userId, sender: "BOT", message: reply },
      ]);
    }

    // 4️⃣ Send reply
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

module.exports = { handleChat, getAllChats };
