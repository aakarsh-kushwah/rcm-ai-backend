const { getAIChatResponse } = require('../services/aiService');
const { db } = require('../config/db');
const { uploadAudioToCloudinary } = require('../services/cloudinaryService');
const { MASTER_PROMPT: SYSTEM_PROMPT } = require('../utils/prompts');
const asyncHandler = require('express-async-handler');
const axios = require('axios');
const crypto = require('crypto');
const stringSimilarity = require("string-similarity");
const NodeCache = require("node-cache");

// ✅ Query Cache
const queryCache = new NodeCache({ stdTTL: 600 });

// ============================================================
// 🛠️ HELPER FUNCTIONS
// ============================================================

function cleanInput(text) {
    if (!text) return "";
    return text.toLowerCase().replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim();
}

// ✅ NEW: Smart Filter to check if question is worth saving
function isSaveableQuestion(text) {
    const t = cleanInput(text);
    
    // 1. Too short? (e.g. "Hi", "Hello", "Kyu", "Nahi")
    if (t.length < 5) return false;
    if (t.split(' ').length < 2) return false; // Single word messages (e.g. "Nutricharge" is ok, but "Nahi" is not)

    // 2. Contextual / Conversational junk?
    const junkWords = ['nahi suna', 'fir se bolo', 'aur batao', 'thank you', 'ok thanks', 'bye', 'hello', 'hi', 'kya hua', 'samjha nahi'];
    if (junkWords.some(junk => t.includes(junk))) return false;

    // 3. Must have some substance (Optional check)
    return true;
}

function generateVariations(sentence) {
    const stopWords = ['what', 'is', 'the', 'a', 'an', 'explain', 'tell', 'me', 'about', 'kya', 'he', 'hai', 'h', 'ka', 'ki', 'ke', '?'];
    const words = cleanInput(sentence).split(' ');
    const topicWords = words.filter(w => !stopWords.includes(w));
    const topic = topicWords.join(' '); 

    if (!topic) return [cleanInput(sentence)];

    return [
        cleanInput(sentence),
        topic,
        `explain ${topic}`, 
        `${topic} kya hai`, 
        `${topic} details`,
        `about ${topic}`,
        `${topic} ke fayde`
    ];
}

async function getOrGenerateVoice(text) {
    if (!text) return null;
    try {
        const cleanText = cleanInput(text);
        const textHash = crypto.createHash('sha256').update(cleanText).digest('hex');

        // A. Check Voice Table
        const cachedVoice = await db.VoiceResponse.findOne({ where: { textHash } });
        if (cachedVoice) return cachedVoice.audioUrl;

        // B. Generate New Voice
        const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
        if (!ELEVENLABS_API_KEY) return null;

        console.log("🎙️ Generating New Audio...");
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/IvLWq57RKibBrqZGpQrC`, 
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            data: {
                text: text.substring(0, 500), 
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.8 }
            },
            responseType: 'arraybuffer'
        });

        const cloudinaryUrl = await uploadAudioToCloudinary(response.data, textHash);
        await db.VoiceResponse.create({ textHash: textHash, originalText: text, audioUrl: cloudinaryUrl, voiceId: "AUTO_GEN" });
        return cloudinaryUrl;
    } catch (error) {
        console.error("⚠️ Voice Auto-Gen Failed:", error.message);
        return null;
    }
}

// ============================================================
// 🔹 MAIN CHAT HANDLER
// ============================================================
const handleChat = asyncHandler(async (req, res) => {
    const { message, chatHistory } = req.body; 
    const userId = req.user ? req.user.id : null;

    if (!message) return res.status(400).json({ success: false, message: "Message required" });

    let replyContent = "";
    let audioUrl = null;
    let source = "AI";
    const userMsgClean = cleanInput(message);

    // --- STEP A: Check RAM Cache ---
    const cachedReply = queryCache.get(userMsgClean);
    if (cachedReply) {
        replyContent = cachedReply;
        source = "CACHE_RAM";
        audioUrl = await getOrGenerateVoice(replyContent);
    }

    // --- STEP B: Check Database ---
    if (!replyContent) {
        try {
            const allFaqs = await db.FAQ.findAll({
                where: { status: 'APPROVED' }, 
                attributes: ['id', 'question', 'answer', 'audioUrl', 'tags']
            });

            let bestMatch = { rating: 0, faq: null };
            allFaqs.forEach(faq => {
                const candidates = [cleanInput(faq.question), ...(faq.tags || [])];
                const match = stringSimilarity.findBestMatch(userMsgClean, candidates);
                if (match.bestMatch.rating > bestMatch.rating) {
                    bestMatch = { rating: match.bestMatch.rating, faq: faq };
                }
            });

            if (bestMatch.rating > 0.50) {
                console.log(`✅ DB HIT: Found answer`);
                replyContent = bestMatch.faq.answer;
                audioUrl = bestMatch.faq.audioUrl; 
                source = "DATABASE";
                if (!audioUrl) {
                    audioUrl = await getOrGenerateVoice(replyContent);
                    if (audioUrl) await bestMatch.faq.update({ audioUrl: audioUrl });
                }
            }
        } catch (err) { console.warn("DB Search Error:", err.message); }
    }

    // --- STEP C: Ask AI (If DB Miss) ---
    if (!replyContent) {
        console.log("🤖 DB MISS: Asking AI...");
        let groqMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (chatHistory) groqMessages = [...groqMessages, ...chatHistory];
        groqMessages.push({ role: "user", content: message });
        
        replyContent = await getAIChatResponse(groqMessages);

        // Clean JSON if present
        try {
            if (replyContent.trim().startsWith('{')) {
                const json = JSON.parse(replyContent);
                replyContent = json.answer || json.content || json.text || replyContent;
            }
        } catch (e) { }

        audioUrl = await getOrGenerateVoice(replyContent);

        // ✅ AUTO-TRAINING FILTER
        // Ab hum check karenge ki kya ye sawal save karne layak hai?
        // Agar "Nahi suna" jaisa kuch hai, toh AI jawab dega par hum DB me save nahi karenge.
        
        const validToSave = isSaveableQuestion(message);

        if (validToSave && replyContent && !replyContent.includes("Error")) {
            const variations = generateVariations(message);
            try {
                await db.FAQ.create({
                    question: userMsgClean,
                    answer: replyContent, 
                    tags: variations,
                    audioUrl: audioUrl,
                    status: 'APPROVED',
                    isUserSubmitted: false
                });
                console.log("💾 SAVED to DB: Useful Question");
            } catch (dbErr) { console.error("Auto-save error:", dbErr.message); }
        } else {
            console.log("🚫 SKIP SAVING: Conversational/Short input.");
        }
        
        queryCache.set(userMsgClean, replyContent);
    }

    if (userId) {
        await db.ChatMessage.bulkCreate([
            { userId, sender: "USER", message: message },
            { userId, sender: "BOT", message: replyContent }, 
        ]);
    }

    res.status(200).json({ 
        success: true, 
        reply: { type: 'text', content: replyContent }, 
        audioUrl, 
        source 
    });
});

const handleSpeak = asyncHandler(async (req, res) => {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
    const url = await getOrGenerateVoice(text);
    if (url) res.json({ success: true, audioUrl: url, source: "api" });
    else res.status(500).json({ error: 'Voice generation failed.' });
});

const addSmartResponse = asyncHandler(async (req, res) => {
    const { question, answer } = req.body;
    const audioFile = req.file;

    if (!question || !answer) return res.status(400).json({ success: false, message: "Missing fields." });

    let cloudinaryUrl = null;
    if (audioFile) {
        const filenameSafe = question.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        cloudinaryUrl = await uploadAudioToCloudinary(audioFile.buffer, filenameSafe);
    }

    const variations = generateVariations(question);
    
    await db.FAQ.create({
        question: cleanInput(question),
        tags: variations,
        answer: answer,
        audioUrl: cloudinaryUrl,
        isUserSubmitted: false,
        status: 'APPROVED'
    });

    if (cloudinaryUrl) {
        const textHash = crypto.createHash('sha256').update(cleanInput(answer)).digest('hex');
        await db.VoiceResponse.destroy({ where: { textHash } });
        await db.VoiceResponse.create({ textHash, originalText: answer, audioUrl: cloudinaryUrl, voiceId: "ADMIN_UPLOAD" });
    }

    queryCache.flushAll(); 
    res.status(201).json({ success: true, message: "Saved!" });
});

const getAllChats = asyncHandler(async (req, res) => { 
    res.status(200).json({ success: true, message: "Chat history" });
});

module.exports = { handleChat, handleSpeak, getAllChats, addSmartResponse };