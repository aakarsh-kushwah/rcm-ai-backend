/**
 * @file src/services/whatsAppBot.js
 * @description RCM Titan Engine - Omni-Channel Bot (Fixed for Render Cloud)
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const stringSimilarity = require("string-similarity");
const { Queue, Worker } = require('bullmq');
const path = require('path');
const fs = require('fs');

// 👇 THE MAGIC FIX: Hum ab Central Config use kar rahe hain
const connection = require('../config/redis'); 

// Services
const { getAIChatResponse } = require('./aiService'); 
const { db } = require('../config/db');
const { WHATSAPP_SYSTEM_PROMPT } = require('../utils/prompts');

const ADMIN_NUMBER = '919343743114@c.us'; 

// 🕵️ Stealth Browser Settings (Anti-Ban & Render Compatible)
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
        
        // 🎭 ACTING PHASE 1: Human Delay (Sochne ka natak)
        const thinkDelay = Math.floor(Math.random() * 2000) + 1500; 
        await new Promise(r => setTimeout(r, thinkDelay));

        // 🎭 ACTING PHASE 2: Mark as Read (Blue Tick)
        await chat.sendSeen();

        // 🎭 ACTING PHASE 3: Action (Photo or Text)
        if (mediaPath && fs.existsSync(mediaPath)) {
            // 📸 Photo Bhejo
            console.log(`🖼️ Uploading Media to ${chatId}...`);
            const media = MessageMedia.fromFilePath(mediaPath);
            
            await chat.sendStateRecording(); // Recording... dikhao
            await new Promise(r => setTimeout(r, 1000));
            await chat.clearState();

            await client.sendMessage(chatId, media, { caption: text });

        } else {
            // 📝 Text Bhejo
            const typingDuration = Math.min((text.length * 40), 5000) + 1000; 
            
            await chat.sendStateTyping(); // Typing... dikhao
            await new Promise(r => setTimeout(r, typingDuration));
            await chat.clearState();
            
            await client.sendMessage(chatId, text);
        }

        console.log(`✅ Sent to ${chatId}`);

    } catch (error) {
        console.error(`❌ Queue Error for ${chatId}:`, error.message);
    }

}, { 
    connection, // 👈 Ye ab Central Config se aa raha hai
    concurrency: 1, 
    limiter: { max: 10, duration: 10000 } 
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
        // Ignore Status & Groups
        if (msg.body === 'status@broadcast' || msg.from.includes('@g.us')) return;
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

        // 1. 🛒 Product Images (Example)
        if (userMsgClean.includes('soap') || userMsgClean.includes('sabun')) {
            mediaToSend = path.join(__dirname, '../public/images/soap.jpg');
            replyContent = "Ye raha RCM ka best sabun! Neem aur Tulsi ke guno ke saath. 🌿";
        }
        else if (userMsgClean.includes('oil') || userMsgClean.includes('tel')) {
            mediaToSend = path.join(__dirname, '../public/images/oil.jpg');
            replyContent = "Health Guard Oil: Aapke dil ka rakshak. ❤️";
        }

        // 2. 🔍 Database Cache
        if (!replyContent) {
            try {
                const approvedFaqs = await db.FAQ.findAll({ where: { status: 'APPROVED' } });
                if (approvedFaqs.length > 0) {
                    const questions = approvedFaqs.map(f => cleanInput(f.question));
                    const match = stringSimilarity.findBestMatch(userMsgClean, questions);
                    
                    if (match.bestMatch.rating > 0.80) {
                        replyContent = approvedFaqs[match.bestMatchIndex].answer;
                    }
                }
            } catch (e) { console.warn("DB Cache Skip:", e.message); }
        }

        // 3. 🧠 AI Generation (Rishika)
        if (!replyContent) {
            try {
                replyContent = await getAIChatResponse([
                    { role: "system", content: WHATSAPP_SYSTEM_PROMPT },
                    { role: "user", content: msg.body }
                ]);
            } catch (e) { 
                console.error("AI Error:", e.message);
                replyContent = "Network issue hai, thodi der baad batati hoon! 🙏";
            }
        }

        // 4. 🚦 Send to Queue
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

            // Save to DB for review
            if (!mediaToSend && replyContent.length > 10) {
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

// 🔔 Admin Alert
const sendAdminAlert = async (text, aiReply) => {
    await replyQueue.add('admin-alert', {
        chatId: ADMIN_NUMBER,
        text: `🚨 *Alert*\nQ: ${text}\nA: ${aiReply.substring(0, 100)}...`,
        isAiGenerated: false
    });
};

module.exports = { initializeWhatsAppBot, sendAdminAlert };