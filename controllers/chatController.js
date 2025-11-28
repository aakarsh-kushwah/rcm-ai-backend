const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');

// ============================================================
// 🛠️ UTILITIES (Enterprise Resilience Helper Functions)
// ============================================================

/**
 * Retry Logic with Exponential Backoff
 * Google/Meta use this to handle network blips without failing the request.
 */
async function withRetry(fn, retries = 3, delay = 1000) {
    try {
        return await fn();
    } catch (error) {
        if (retries === 0) throw error;
        
        // Check if error is retryable (e.g., 503, 429, Network Error)
        const isRetryable = !error.response || error.response.status >= 500 || error.response.status === 429;
        
        if (!isRetryable) throw error;

        console.warn(`⚠️ API Glitch. Retrying in ${delay}ms... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return withRetry(fn, retries - 1, delay * 2); // Double the delay each time
    }
}

/**
 * Sanitizes AI Response to prevent JSON parsing crashes.
 * Handles cases where AI wraps JSON in markdown code blocks.
 */
function cleanAIResponse(rawString) {
    if (!rawString) return "{}";
    // Remove markdown code blocks (```json ... ```) and whitespace
    return rawString.replace(/```json/g, "").replace(/```/g, "").trim();
}

// ============================================================
// 🔹 1. Handle User Chat (Text Logic) - Smart & Robust
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ success: false, message: "Valid message content is required." });
    }

    // 1. Intelligent Context Windowing
    // Only keep the last 10 messages to save tokens and reduce latency.
    let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
    
    if (chatHistory && Array.isArray(chatHistory)) {
        const recentHistory = chatHistory.slice(-10).map(msg => ({
            role: msg.role,
            content: String(msg.content).substring(0, 500) // Truncate extremely long messages
        }));
        groqMessages = [...groqMessages, ...recentHistory];
    }
    groqMessages.push({ role: "user", content: message });
    
    // 2. AI Execution with Resilience
    let replyString;
    try {
        replyString = await withRetry(() => getAIChatResponse(groqMessages));
    } catch (error) {
        console.error("❌ AI Service Critical Failure:", error.message);
        // Fail gracefully instead of crashing
        return res.json({ 
            success: true, 
            reply: { type: 'text', content: "I'm currently experiencing high traffic. Please try again in a moment." } 
        });
    }

    // 3. Advanced Response Parsing
    let replyContent = "";
    let jsonReply = null;

    try {
        const sanitizedString = cleanAIResponse(replyString);
        jsonReply = JSON.parse(sanitizedString);
        
        // Normalize response structure
        replyContent = jsonReply.content || jsonReply.text || jsonReply.message || replyString;
        
        // Enforce standardized schema for Frontend
        if (!jsonReply.type) {
            jsonReply = { type: 'text', content: replyContent };
        }
    } catch (e) {
        // Fallback: If AI returns plain text, wrap it gracefully
        console.warn("⚠️ JSON Parse Failed, using raw text fallback.");
        replyContent = replyString;
        jsonReply = { type: 'text', content: replyString };
    }

    // 4. Fire-and-Forget Database Logging (Non-blocking)
    // Don't make the user wait for DB write.
    if (userId) {
        db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]).catch(err => console.error("⚠️ Failed to save chat history (Non-critical):", err.message));
    }

    // 5. Send Response
    res.status(200).json({ success: true, reply: jsonReply });
});

// ============================================================
// 🔹 2. Handle Speak (Voice) - OpenAI TTS (Low Latency Stream)
// ============================================================
const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 

    if (!text) return res.status(400).json({ error: 'Text is required.' });
    
    if (!OPENAI_API_KEY) {
        console.error("❌ CRITICAL: OPENAI_API_KEY is missing in Environment Variables!");
        return res.status(500).json({ error: 'Server Configuration Error: AI Voice Key Missing' });
    }

    try {
        const ttsRequest = {
            method: 'POST',
            url: 'https://api.openai.com/v1/audio/speech',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            data: {
                model: "tts-1",       // Optimized for speed (Low Latency)
                input: text,
                voice: "nova",        // Energetic & Professional Voice
                response_format: "mp3",
                speed: 1.05           // Slightly faster for conversational feel
            },
            responseType: 'stream',   // Crucial for real-time playback
            timeout: 10000            // 10s Hard Timeout
        };

        // Execute with Retry Logic
        const response = await withRetry(() => axios(ttsRequest), 2, 500);

        // Optimize Headers for Streaming
        res.set({
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no' // Disable Nginx buffering if behind proxy
        });
        
        // Pipe stream directly to client
        response.data.pipe(res);

        // Handle Stream Interruptions
        response.data.on('error', (streamErr) => {
            console.error('🔥 Audio Stream Broken:', streamErr);
            if (!res.headersSent) res.status(500).end();
        });

    } catch (error) {
        console.error('🔥 Voice API Failure:', error.message);
        
        if (error.response) {
            const status = error.response.status;
            if (status === 401) {
                console.error("❌ Invalid OpenAI API Key.");
                return res.status(500).json({ error: 'Voice Service Config Error' });
            }
            if (status === 429) {
                console.error("❌ Quota Exceeded.");
                return res.status(429).json({ error: 'Voice service busy, please type instead.' });
            }
        }
        
        res.status(500).json({ error: 'Unable to generate voice at this moment.' });
    }
});

// ============================================================
// 🔹 3. Admin: Get All Chats (Optimized for Data Loads)
// ============================================================
const getAllChats = asyncHandler(async (req, res) => {
    try {
        // Use attributes to fetch only necessary columns (SQL Optimization)
        const allMessages = await db.ChatMessage.findAll({
            attributes: ['sender', 'message', 'createdAt'],
            include: [
                {
                    model: db.User,
                    attributes: ["email", "fullName"], 
                },
            ],
            order: [["createdAt", "DESC"]],
            limit: 500 // Hard limit to prevent memory overflow
        });

        // Aggregation Logic
        const chatsByUser = {};
        allMessages.forEach((msg) => {
            if (!msg.User) return; // Skip orphaned messages
            
            const userKey = `${msg.User.fullName} (${msg.User.email})`;
            
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
        res.status(500).json({ success: false, message: "Failed to retrieve data." });
    }
});

module.exports = { handleChat, handleSpeak, getAllChats };