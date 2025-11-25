const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios'); // ✅ Voice API call ke liye

// ============================================================
// 🔹 1. Handle User Chat (AI Text)
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, mode, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) {
        return res.status(400).json({ success: false, message: "Message content is required." });
    }

    // 1️⃣ Message Array taiyaar karein
    let groqMessages = [
        { role: "system", content: SYSTEM_PROMPT } 
    ];

    // Purani history add karein
    if (chatHistory && Array.isArray(chatHistory)) {
        groqMessages = [...groqMessages, ...chatHistory];
    }

    // Current message add karein
    groqMessages.push({ 
        role: "user", 
        content: `(Current Mode: ${mode || 'General'}) ${message}` 
    });
    
    // 2️⃣ AI se Jawab mangein
    const replyString = await getAIChatResponse(groqMessages);

    // 3️⃣ JSON Parse karein
    let replyContent = "";
    let jsonReply = null;

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

    // 4️⃣ Database mein save karein
    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Voice (Text-to-Speech via ElevenLabs)
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    
    // 🎙️ Voice ID: "Rachel" (Professional & Clear)
    // Aap ElevenLabs dashboard se doosri ID bhi le sakte hain
    const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    if (!ELEVENLABS_API_KEY) {
        console.error("❌ ElevenLabs API Key missing in Environment Variables!");
        return res.status(500).json({ error: 'Server configuration error: Voice Key Missing' });
    }

    try {
        // ElevenLabs API ko call karein
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
            headers: {
                'Accept': 'audio/mpeg',
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
            },
            data: {
                text: text,
                model_id: "eleven_monolingual_v1", // Low latency model
                voice_settings: {
                    stability: 0.5,       // Thoda emotion allow karein
                    similarity_boost: 0.75 // Awaz saaf rakhein
                }
            },
            responseType: 'stream' // ⚡ Important: Stream response for speed
        });

        // Audio stream wapas frontend bhejein
        res.set('Content-Type', 'audio/mpeg');
        response.data.pipe(res);

    } catch (error) {
        console.error('Voice Generation Error:', error.message);
        res.status(500).json({ error: 'Failed to generate voice' });
    }
});

// ============================================================
// 🔹 3. Admin: Get All Chats
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

module.exports = { 
    handleChat, 
    handleSpeak, // ✅ Export added
    getAllChats 
};