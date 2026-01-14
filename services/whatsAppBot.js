/**
 * @file src/services/whatsAppBot.js
 * @description RCM Titan Engine - Rishika Persona (Human Simulation Mode)
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const stringSimilarity = require("string-similarity");
const { Queue, Worker } = require('bullmq');
const path = require('path');
const fs = require('fs');

const connection = require('../config/redis'); 
const { getAIChatResponse } = require('./aiService'); 
const { db } = require('../config/db');
const { WHATSAPP_SYSTEM_PROMPT } = require('../utils/prompts');

const ADMIN_NUMBER = '919343743114@s.whatsapp.net';

let sock;
let isReady = false;

// ==============================================================================
// 🚦 HUMAN-LIKE REPLY WORKER (Anti-Detection)
// ==============================================================================
const replyQueue = new Queue('whatsapp-human-replies', { connection });

const replyWorker = new Worker('whatsapp-human-replies', async (job) => {
    const { chatId, text, mediaPath } = job.data;
    if (!sock) return;

    try {
        // 1. 👀 MESSAGE READ: Pehle blue tick aayega
        await sock.readMessages([chatId]);

        // 2. 🤔 THINKING DELAY: Insan ki tarah thoda wait karna (1.5 to 3 seconds)
        const thinkingTime = Math.floor(Math.random() * 1500) + 1500;
        await new Promise(r => setTimeout(r, thinkingTime));

        // 3. ✍️ TYPING SIMULATION: Reply ki length ke hisab se "Typing..." status
        await sock.sendPresenceUpdate('composing', chatId);
        
        // Typing duration: Har character ke liye approx 50ms (Max 5 sec)
        const typingDuration = Math.min((text.length * 50), 5000) + 500;
        await new Promise(r => setTimeout(r, typingDuration));
        
        // Typing khatam
        await sock.sendPresenceUpdate('paused', chatId);

        // 4. 🚀 SEND MESSAGE
        if (mediaPath && fs.existsSync(mediaPath)) {
            await sock.sendMessage(chatId, { image: { url: mediaPath }, caption: text });
        } else {
            await sock.sendMessage(chatId, { text: text });
        }
        
        console.log(`✅ Rishika Replied to ${chatId}`);

    } catch (error) {
        console.error(`❌ Reply Error:`, error.message);
    }

}, { 
    connection, 
    concurrency: 1, // Ek baar mein ek hi reply (Pure Human behavior)
    limiter: { max: 1, duration: 2000 } // Minimum 2 sec gap har reply ke beech
});

// ==============================================================================
// 🚀 CONNECTION LOGIC
// ==============================================================================

function cleanInput(text) {
    if (!text) return "";
    return text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '').trim().substring(0, 500); 
}

const initializeWhatsAppBot = async () => {
    console.log("🔄 Initializing Rishika Persona (Baileys Engine)...");

    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ["RCM Office", "Windows", "10.0"], // Insan jaisa identity
        syncFullHistory: false,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if(qr) {
            console.log('📱 QR RECEIVED (Scan karein):');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) initializeWhatsAppBot();
        } else if (connection === 'open') {
            console.log('✅ Rishika is Online & Ready to help!');
            isReady = true;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";

            if (!text) return;
            console.log(`📩 New message from ${sender}: ${text}`);
            
            await handleIncomingMessage(sender, text);
        } catch (err) { console.error("Event Error:", err); }
    });
};

// ==============================================================================
// 🧠 RISHIKA'S DECISION ENGINE
// ==============================================================================
async function handleIncomingMessage(chatId, text) {
    try {
        const userMsgClean = cleanInput(text);
        let replyContent = "";
        let mediaToSend = null;

        // 1. Fast Keyword Match (For common products)
        if (userMsgClean.includes('soap') || userMsgClean.includes('sabun')) {
            mediaToSend = path.join(__dirname, '../public/images/soap.jpg');
            replyContent = "Bilkul, RCM ka sabun (soap) best hai! Ye raha iska photo aur details. 🌿";
        }

        // 2. DB FAQ Cache
        if (!replyContent) {
            try {
                const approvedFaqs = await db.FAQ.findAll({ where: { status: 'APPROVED' } });
                if (approvedFaqs.length > 0) {
                    const questions = approvedFaqs.map(f => cleanInput(f.question));
                    const match = stringSimilarity.findBestMatch(userMsgClean, questions);
                    if (match.bestMatch.rating > 0.85) {
                        replyContent = approvedFaqs[match.bestMatchIndex].answer;
                    }
                }
            } catch (e) {}
        }

        // 3. AI Neural Generation (Rishika Persona)
        if (!replyContent) {
            try {
                replyContent = await getAIChatResponse([
                    { role: "system", content: WHATSAPP_SYSTEM_PROMPT },
                    { role: "user", content: text }
                ]);
            } catch (e) { 
                replyContent = "Maaf kijiyega, thoda network problem hai. Main abhi check karke batati hoon! 🙏";
            }
        }

        // 4. Send to Human-Like Queue
        if (replyContent) {
            await replyQueue.add('human-reply', {
                chatId,
                text: replyContent,
                mediaPath: mediaToSend
            }, { removeOnComplete: true });

            // Log to Database for training
            db.FAQ.create({
                question: text,
                answer: replyContent,
                status: 'PENDING_REVIEW',
                isUserSubmitted: true
            }).catch(e => {});
        }

    } catch (err) {
        console.error('Logic Error:', err.message);
    }
}

module.exports = { initializeWhatsAppBot };