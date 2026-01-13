/**
 * @file src/services/whatsAppBot.js
 * @description RCM Titan Engine - Anti-Ban WhatsApp Bot
 * @architecture Redis Queue | Human Simulation | Stealth Mode
 * @capacity 5000+ Messages/Day safely
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const stringSimilarity = require("string-similarity");
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

// Services
const { getAIChatResponse } = require('./aiService'); 
const { db } = require('../config/db');
let { SYSTEM_PROMPT } = require('../utils/prompts');

// ==============================================================================
// ⚙️ CONFIGURATION & STEALTH
// ==============================================================================
const ADMIN_NUMBER = '919343743114@c.us'; 
const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null
};

// 🕵️ Browser ko chupaane ke settings
const STEALTH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled', // 👈 Sabse Important: Robot detection band
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

let client;
let isReady = false;

// ==============================================================================
// 🚦 TRAFFIC CONTROLLER (REDIS QUEUE)
// ==============================================================================
// Is queue me hum replies daalenge, jo dhire-dhire jayenge
const connection = new IORedis(REDIS_CONFIG);
const replyQueue = new Queue('whatsapp-human-replies', { connection });

// 🧠 QUEUE WORKER (Ye background me act karega)
const replyWorker = new Worker('whatsapp-human-replies', async (job) => {
    const { chatId, text, isAiGenerated } = job.data;
    
    if (!client || !isReady) return;

    try {
        const chat = await client.getChatById(chatId);
        
        // 🎭 ACTING PHASE 1: Thoda ruko (Thinking time)
        const thinkDelay = Math.floor(Math.random() * 2000) + 1000; // 1-3 sec
        await new Promise(r => setTimeout(r, thinkDelay));

        // 🎭 ACTING PHASE 2: Blue Tick (Mark as Read)
        await chat.sendSeen();

        // 🎭 ACTING PHASE 3: Typing Simulation
        // Jitna bada message, utni der typing dikhao
        const typingDuration = Math.min((text.length * 50), 4000) + 1000; // Min 1s, Max 5s
        await chat.sendStateTyping();
        
        await new Promise(r => setTimeout(r, typingDuration));

        // 🚀 FINAL: Message Bhejo
        await client.sendMessage(chatId, text);
        
        // Typing band karo
        await chat.clearState();

        console.log(`✅ Sent to ${chatId} (Human Delay: ${typingDuration}ms)`);

    } catch (error) {
        console.error(`❌ Queue Error for ${chatId}:`, error.message);
    }
}, { 
    connection, 
    concurrency: 1, // ⚠️ STRICTLY 1: Ek baar me 1 hi message bhejenge taaki ban na ho
    limiter: {
        max: 10,      // Max 10 messages
        duration: 10000 // per 10 seconds (Rate Limiting)
    } 
});

// ==============================================================================
// 🚀 MAIN LOGIC
// ==============================================================================

function cleanInput(text) {
    if (!text) return "";
    return text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '').trim().substring(0, 500); 
}

const initializeWhatsAppBot = () => {
    console.log("🔄 Initializing Neural WhatsApp Engine...");

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './auth_session' }),
        puppeteer: { 
            headless: true, 
            args: STEALTH_ARGS
        }
    });

    client.on('qr', (qr) => {
        console.log('📱 QR RECEIVED:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Neural Link Connected!');
        isReady = true;
    });

    client.on('message', async (msg) => {
        // 🛡️ Filter bad messages
        if (msg.body === 'status@broadcast' || msg.from.includes('@g.us')) return;

        // Queue me daalne se server free ho jata hai
        handleIncomingMessage(msg);
    });

    client.initialize();
};

// 🧠 MESSAGE PROCESSOR (The Brain)
// Ye function fast chalega, reply queue me dalega
async function handleIncomingMessage(msg) {
    try {
        const userMsgClean = cleanInput(msg.body);
        if (userMsgClean.length < 2) return; 

        let replyContent = "";
        let isAiGenerated = false;

        // 1. 🔍 DATABASE CACHE (Fastest)
        try {
            const approvedFaqs = await db.FAQ.findAll({ where: { status: 'APPROVED' } });
            if (approvedFaqs.length > 0) {
                const questions = approvedFaqs.map(f => cleanInput(f.question));
                const match = stringSimilarity.findBestMatch(userMsgClean, questions);
                
                if (match.bestMatch.rating > 0.75) {
                    replyContent = approvedFaqs[match.bestMatchIndex].answer;
                    isAiGenerated = false;
                }
            }
        } catch (e) { console.warn("DB Read Error:", e.message); }

        // 2. 🧠 AI GENERATION (Groq)
        if (!replyContent) {
            isAiGenerated = true;
            try {
                // User ko turant reply mat karo, pehle soch lo
                replyContent = await getAIChatResponse([
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: msg.body }
                ]);
            } catch (e) { 
                replyContent = "Abhi network busy hai, thodi der me puchiye.";
            }
        }

        // 3. 🚦 ADD TO QUEUE (Direct Send Mat Karo!)
        if (replyContent) {
            // Hum yahan reply nahi kar rahe, hum bas Queue Manager ko bol rahe hain
            // ki "Jab free ho tab ye message bhej dena with acting"
            await replyQueue.add('send-reply', {
                chatId: msg.from,
                text: replyContent,
                isAiGenerated
            }, {
                removeOnComplete: true,
                attempts: 3
            });

            // Log for Admin
            if (isAiGenerated && userMsgClean.length > 5) {
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

// 🔔 ADMIN ALERT (Queued)
const sendAdminAlert = async (text, aiReply) => {
    await replyQueue.add('admin-alert', {
        chatId: ADMIN_NUMBER,
        text: `🚨 *Alert*\nQ: ${text}\nA: ${aiReply.substring(0, 100)}...`,
        isAiGenerated: false
    });
};

module.exports = { initializeWhatsAppBot, sendAdminAlert };