/**
 * @file src/services/whatsAppBot.js
 * @description RCM Titan Engine - Omni-Channel Bot (Windows Safe Mode)
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const stringSimilarity = require("string-similarity");
const { Queue, Worker } = require('bullmq');
const path = require('path');
const fs = require('fs');

// 👇 Central Redis Config
const connection = require('../config/redis'); 

// Services
const { getAIChatResponse } = require('./aiService'); 
const { db } = require('../config/db');
const { WHATSAPP_SYSTEM_PROMPT } = require('../utils/prompts');

const ADMIN_NUMBER = '919343743114@c.us'; 

// ==============================================================================
// 🕵️ SMART BROWSER CONFIGURATION (OS Detection Fix)
// ==============================================================================

// Logic: Lite Mode sirf tab on karo jab hum Render par hon, ya Linux par hon.
// Agar Windows hai, to kabhi bhi Lite Mode mat lagao (kyunki wo crash karta hai).
const isRenderCloud = process.env.RENDER || (process.platform === 'linux' && process.env.NODE_ENV === 'production');

console.log(`🖥️ System Detected: ${process.platform}`);
console.log(`🚀 Mode: ${isRenderCloud ? '☁️ CLOUD (Super Lite)' : '🏠 WINDOWS/LOCAL (Safe Mode)'}`);

const STEALTH_ARGS = isRenderCloud 
    ? [ 
        // ☁️ CLOUD/LINUX SETTINGS (Aggressive RAM Saving)
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // ⚠️ SIRF LINUX KE LIYE
        '--disable-gpu',
        '--disable-gl-drawing-for-tests',
        '--disable-software-rasterizer',
        '--mute-audio',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    : [
        // 🏠 WINDOWS LOCAL SETTINGS (Crash Proof)
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        // Note: '--single-process' removed to prevent Windows crash
      ];

let client;
let isReady = false;

// ==============================================================================
// 🚦 TRAFFIC CONTROLLER (Queue System)
// ==============================================================================
const replyQueue = new Queue('whatsapp-human-replies', { connection });

const replyWorker = new Worker('whatsapp-human-replies', async (job) => {
    const { chatId, text, mediaPath, isAiGenerated } = job.data;
    
    if (!client || !isReady) return;

    try {
        const chat = await client.getChatById(chatId);
        
        // 🎭 ACTING PHASE
        const thinkDelay = Math.floor(Math.random() * 2000) + 1500; 
        await new Promise(r => setTimeout(r, thinkDelay));
        await chat.sendSeen();

        if (mediaPath && fs.existsSync(mediaPath)) {
            console.log(`🖼️ Uploading Media to ${chatId}...`);
            const media = MessageMedia.fromFilePath(mediaPath);
            await chat.sendStateRecording(); 
            await new Promise(r => setTimeout(r, 1000));
            await chat.clearState();
            await client.sendMessage(chatId, media, { caption: text });
        } else {
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
    connection, 
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
            args: STEALTH_ARGS,
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
        if (msg.body === 'status@broadcast' || msg.from.includes('@g.us')) return;
        handleIncomingMessage(msg);
    });

    client.initialize();
};

async function handleIncomingMessage(msg) {
    try {
        const userMsgClean = cleanInput(msg.body);
        if (userMsgClean.length < 2) return; 

        let replyContent = "";
        let mediaToSend = null;

        // 1. Product Logic
        if (userMsgClean.includes('soap') || userMsgClean.includes('sabun')) {
            mediaToSend = path.join(__dirname, '../public/images/soap.jpg');
            replyContent = "Ye raha RCM ka best sabun! Neem aur Tulsi ke guno ke saath. 🌿";
        }
        else if (userMsgClean.includes('oil') || userMsgClean.includes('tel')) {
            mediaToSend = path.join(__dirname, '../public/images/oil.jpg');
            replyContent = "Health Guard Oil: Aapke dil ka rakshak. ❤️";
        }

        // 2. DB Cache
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

        // 3. AI Generation
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

        // 4. Send to Queue
        if (replyContent) {
            await replyQueue.add('send-reply', {
                chatId: msg.from,
                text: replyContent,
                mediaPath: mediaToSend,
                isAiGenerated: !mediaToSend
            }, { removeOnComplete: true, attempts: 3 });

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

const sendAdminAlert = async (text, aiReply) => {
    await replyQueue.add('admin-alert', {
        chatId: ADMIN_NUMBER,
        text: `🚨 *Alert*\nQ: ${text}\nA: ${aiReply.substring(0, 100)}...`,
        isAiGenerated: false
    });
};

module.exports = { initializeWhatsAppBot, sendAdminAlert };