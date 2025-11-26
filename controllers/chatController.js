const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// ============================================================
// 🔹 1. Handle User Chat (Text Logic) - Groq AI
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
  const { message, chatHistory } = req.body; 
  const userId = req.user ? req.user.id : null;

  if (!message) {
    return res.status(400).json({ success: false, message: "Message content is required." });
  }

  // 1. Construct Message Array
  let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
  
  if (chatHistory && Array.isArray(chatHistory)) {
    const recentHistory = chatHistory.slice(-6); 
    groqMessages = [...groqMessages, ...recentHistory];
  }
  groqMessages.push({ role: "user", content: message });
  
  // 2. Get AI Response
  const replyString = await getAIChatResponse(groqMessages);

  // 3. Clean Response
  let replyContent = replyString; 
  let jsonReply = { type: 'text', content: replyContent };

  try {
    const parsed = JSON.parse(replyString);
    replyContent = parsed.content || parsed.text || replyString;
    jsonReply = parsed;
  } catch (e) {
    // Keep as text if JSON parse fails
  }

  // 4. Save to DB
  if (userId) {
    db.ChatMessage.bulkCreate([
        { userId, sender: "USER", message: message },
        { userId, sender: "BOT", message: replyContent }, 
    ]).catch(err => console.error("History Save Error:", err.message));
  }

  res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Speak (Gemini Voice Engine) - ELEVENLABS
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
  const { text } = req.body;
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; 

  if (!text || !ELEVENLABS_API_KEY) {
    return res.status(400).json({ error: 'Config missing or empty text' });
  }

  try {
    const response = await axios({
      method: 'POST',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      data: {
        text: text,
        model_id: "eleven_multilingual_v2", 
        voice_settings: {
          stability: 0.5,       
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        },
        optimize_streaming_latency: 3 
      },
      responseType: 'stream'
    });

    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked'
    });
    
    response.data.pipe(res);

  } catch (error) {
    console.error('Voice Gen Error:', error.message);
    res.status(500).json({ error: 'Voice generation failed' });
  }
});

// ============================================================
// 🔹 3. Admin: Get All Chats (THIS WAS MISSING)
// ============================================================
const getAllChats = asyncHandler(async (req, res) => {
    try {
        const allMessages = await db.ChatMessage.findAll({
            include: [
                {
                    model: db.User,
                    attributes: ["email", "fullName"], 
                },
            ],
            order: [["createdAt", "DESC"]],
            limit: 1000 
        });

        const chatsByUser = {};
        allMessages.forEach((msg) => {
            const userKey = msg.User ? `${msg.User.fullName} (${msg.User.email})` : "Unknown User";
            if (!chatsByUser[userKey]) {
                chatsByUser[userKey] = [];
            }
            chatsByUser[userKey].push({
                sender: msg.sender,
                message: msg.message,
                createdAt: msg.createdAt,
            });
        });

        res.status(200).json({ success: true, data: chatsByUser });
    } catch (error) {
        console.error("Admin Fetch Error:", error);
        res.status(500).json({ success: false, message: "Failed to retrieve chat history." });
    }
});

// ✅ Export ALL functions
module.exports = { handleChat, handleSpeak, getAllChats };