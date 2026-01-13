/**
 * @file src/services/whatsAppBot.js
 * @description RCM Titan Engine - "Next Gen" Omni-Channel Bot
 * @features Cloud Redis (Upstash) | Rishika Persona | Multimedia Support | Anti-Ban
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const stringSimilarity = require("string-similarity");
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const path = require('path');
const fs = require('fs');

// Services
const { getAIChatResponse } = require('./aiService'); 
const { db } = require('../config/db');

// 👇 IMPORTANT: Hum specifically 'WHATSAPP' wala prompt use karenge (Rishika)
const { WHATSAPP_SYSTEM_PROMPT } = require('../utils/prompts');

// ==============================================================================
// ⚙️ INTELLIGENT CONFIGURATION (Cloud + Local Support)
// ==============================================================================
const ADMIN_NUMBER = '919343743114@c.us'; 

// 🔌 Redis Connection Logic (The "Render Fix")
// Agar Render par hain (REDIS_URL hai), to Cloud use karo.
// Agar apne PC par hain, to Localhost use karo.
let connection;

if (process.env.REDIS_URL) {
    // ☁️ CLOUD MODE (Render / Upstash)
    console.log("🔗 Connecting to Cloud Redis (Upstash)...");
    connection = new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        // TLS option zaroori hai secure connection ke liye
        tls: { rejectUnauthorized: false } 
    });
} else {
    // 🏠 LOCAL MODE (Apna PC)
    console.log("🔗 Connecting to Local Redis...");
    connection = new IORedis({
        host: '127.0.0.1',
        port: 6379,
        maxRetriesPerRequest: null
    });
}

// 🕵️ Stealth Browser Settings (Anti-Ban)
const STEALTH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

let client;
let isReady = false;

// ==============================================================================
// 🚦 TRAFFIC CONTROLLER (Queue System)
// ==============================================================================
const replyQueue = new Queue('whatsapp-human-replies', { connection });

// 🧠 WORKER (The Actor)
const replyWorker = new Worker('whatsapp-human-replies', async (job) => {
    const { chatId, text, mediaPath, isAiGenerated } = job.data;
    
    if (!client || !isReady) return;

    try {
        const chat = await client.getChatById(chatId);
        
        // 🎭 ACTING PHASE 1: Human Delay (Thinking time)
        // 1.5 se 3.5 second ka random delay
        const thinkDelay = Math.floor(Math.random() * 2000) + 1500; 
        await new Promise(r => setTimeout(r, thinkDelay));

        // 🎭 ACTING PHASE 2: Mark as Read (Blue Tick)
        await chat.sendSeen();

        // 🎭 ACTING PHASE 3: Action (Photo or Text)
        if (mediaPath && fs.existsSync(mediaPath)) {
            // 📸 Agar Photo bhejni hai
            console.log(`🖼️ Uploading Media to ${chatId}...`);
            const media = MessageMedia.fromFilePath(mediaPath);
            
            // Photo upload hone ka time simulate karo
            await chat.sendStateRecording(); 
            await new Promise(r => setTimeout(r, 1000));
            await chat.clearState();

            // Caption ke saath bhejo
            await client.sendMessage(chatId, media, { caption: text });

        } else {
            // 📝 Agar sirf Text bhejna hai
            // Jitna lamba message, utni der typing dikhao (Human behavior)
            const typingDuration = Math.min((text.length * 40), 5000) + 1000; 
            
            await chat.sendStateTyping();
            await new Promise(r => setTimeout(r, typingDuration));
            await chat.clearState();
            
            await client.sendMessage(chatId, text);
        }

        console.log(`✅ Sent to ${chatId}`);

    } catch (error) {
        console.error(`❌ Queue Error for ${chatId}:`, error.message);
    }

}, { 
    connection, // Cloud/Local connection automatically use hoga
    concurrency: 1, // Ek baar mein 1 message (Safety ke liye)
    limiter: { max: 10, duration: 10000 } // Rate limit: 10 msg per 10 sec
});

// ==============================================================================
// 🚀 MAIN LOGIC
// ==============================================================================

function cleanInput(text) {
    if (!text) return "";
    return text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '').trim().substring(0, 500); 
}

const initializeWhatsAppBot = () => {
    console.log("🔄 Initializing Neural WhatsApp Engine (Persona: Rishika)...");

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './auth_session' }),
        puppeteer: { 
            headless: true, 
            args: STEALTH_ARGS
        }
    });

    client.on('qr', (qr) => {
        console.log('📱 QR RECEIVED (Scan karein):');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Connected! Rishika is Online.');
        isReady = true;
    });

    client.on('message', async (msg) => {
        // 🔍 Debugging Log (Ye dekhne ke liye ki message aa raha hai ya nahi)
        console.log(`📩 MSG: ${msg.body} | FROM: ${msg.from}`);

        // Ignore Status & Groups
        if (msg.body === 'status@broadcast' || msg.from.includes('@g.us')) return;

        // Process Message
        handleIncomingMessage(msg);
    });

    client.initialize();
};

// 🧠 BRAIN (Decision Maker)
async function handleIncomingMessage(msg) {
    try {
        const userMsgClean = cleanInput(msg.body);
        if (userMsgClean.length < 2) return; 

        let replyContent = "";
        let mediaToSend = null;

        // ======================================================================
        // 1. 🛒 PRODUCT IMAGE LOGIC (Example)
        // ======================================================================
        if (userMsgClean.includes('soap') || userMsgClean.includes('sabun')) {
            mediaToSend = path.join(__dirname, '../public/images/soap.jpg');
            replyContent = "Ye raha RCM ka best sabun! Neem aur Tulsi ke guno ke saath. 🌿";
        }
        else if (userMsgClean.includes('oil') || userMsgClean.includes('tel')) {
            mediaToSend = path.join(__dirname, '../public/images/oil.jpg');
            replyContent = "Health Guard Oil: Aapke dil ka rakshak. ❤️";
        }

        // ======================================================================
        // 2. 🔍 DATABASE CACHE (Fast Answers)
        // ======================================================================
        if (!replyContent) {
            try {
                const approvedFaqs = await db.FAQ.findAll({ where: { status: 'APPROVED' } });
                if (approvedFaqs.length > 0) {
                    const questions = approvedFaqs.map(f => cleanInput(f.question));
                    const match = stringSimilarity.findBestMatch(userMsgClean, questions);
                    
                    if (match.bestMatch.rating > 0.80) { // High confidence only
                        replyContent = approvedFaqs[match.bestMatchIndex].answer;
                    }
                }
            } catch (e) { console.warn("DB Cache Skip:", e.message); }
        }

        // ======================================================================
        // 3. 🧠 AI GENERATION (Persona: Rishika)
        // ======================================================================
        if (!replyContent) {
            try {
                replyContent = await getAIChatResponse([
                    { role: "system", content: WHATSAPP_SYSTEM_PROMPT }, // Rishika Prompt
                    { role: "user", content: msg.body }
                ]);
            } catch (e) { 
                console.error("AI Error:", e.message);
                replyContent = "Network issue hai sir, thodi der baad batati hoon! 🙏";
            }
        }

        // ======================================================================
        // 4. 🚦 SEND TO QUEUE
        // ======================================================================
        if (replyContent) {
            await replyQueue.add('send-reply', {
                chatId: msg.from,
                text: replyContent,
                mediaPath: mediaToSend,
                isAiGenerated: !mediaToSend
            }, { 
                removeOnComplete: true,
                attempts: 3
            });

            // Admin Log (Optional - Database me entry)
            if (!mediaToSend && isAiGenerated) {
                db.FAQ.create({
                    question: msg.body,
                    answer: replyContent,
                    status: 'PENDING_REVIEW',
                    isUserSubmitted: true
                }).catch(e => {});
            }
        }

    } catch (err) {
        console.error('Processing Error:', err.message);
    }
}

// 🔔 ADMIN ALERT SYSTEM
const sendAdminAlert = async (text, aiReply) => {
    await replyQueue.add('admin-alert', {
        chatId: ADMIN_NUMBER,
        text: `🚨 *Alert*\nQ: ${text}\nA: ${aiReply.substring(0, 100)}...`,
        isAiGenerated: false
    });
};

module.exports = { initializeWhatsAppBot, sendAdminAlert };