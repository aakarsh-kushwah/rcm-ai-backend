/**
 * @file src/services/whatsAppBot.js
 * @description Cloud-Ready WhatsApp Bot (Render Compatible).
 * @status Active | Text-Only Mode | Puppeteer Hardened
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const stringSimilarity = require("string-similarity");

// Services
const { getAIChatResponse } = require('./aiService'); 
const { db } = require('../config/db');
let { SYSTEM_PROMPT } = require('../utils/prompts');

// Configuration
const ADMIN_NUMBER = '919343743114@c.us'; // Admin Alert Number
const MAX_INPUT_LENGTH = 500;
let client;
let isReady = false;

// Helpers
const humanDelay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function cleanInput(text) {
    if (!text) return "";
    return text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/gi, '').trim().substring(0, MAX_INPUT_LENGTH); 
}

// ==============================================================================
// 🚀 MAIN INITIALIZATION (RENDER SPECIAL)
// ==============================================================================
const initializeWhatsAppBot = () => {
    console.log("🔄 Initializing WhatsApp Service (Cloud Mode)...");

    client = new Client({
        // 1. Storage Strategy
        // Note: Render par restart hone par session ud jayega (LocalAuth limitation).
        // Deploy ke baad Logs mein QR scan karna padega.
        authStrategy: new LocalAuth({ dataPath: './auth_session' }),

        // 2. Browser Configuration (CRITICAL FOR RENDER)
        puppeteer: { 
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Memory crash rokta hai
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu'
            ]
        }
    });

    // 📱 QR Code Generation
    client.on('qr', (qr) => {
        console.log('📱 QR CODE RECEIVED (Scan from Terminal/Logs):');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Bot Connected & Ready!');
        isReady = true;
    });

    client.on('authenticated', () => {
        console.log('🔐 Client Authenticated');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Authentication Failure:', msg);
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp Disconnected:', reason);
        isReady = false;
        // Auto-reconnect logic optional here, usually Render restarts the service
    });

    // 📩 MESSAGE HANDLING LOGIC
    client.on('message', async (msg) => {
        // Filter: Status updates aur Group messages ignore karein
        if (msg.body === 'status@broadcast' || msg.from.includes('@g.us')) return;

        try {
            const userMsgClean = cleanInput(msg.body);
            if (userMsgClean.length < 2) return; 

            // Typing Indicator
            const chat = await msg.getChat();
            if (chat) await chat.sendStateTyping();

            let replyContent = "";
            let isNewQuestion = false;

            // 1. 🔍 DATABASE CHECK (Cache)
            try {
                const approvedFaqs = await db.FAQ.findAll({ where: { status: 'APPROVED' } });
                if (approvedFaqs.length > 0) {
                    const questions = approvedFaqs.map(f => cleanInput(f.question));
                    const match = stringSimilarity.findBestMatch(userMsgClean, questions);
                    
                    if (match.bestMatch.rating > 0.75) {
                        replyContent = approvedFaqs[match.bestMatchIndex].answer;
                        // console.log("✅ DB Match Found");
                    }
                }
            } catch (e) {
                console.warn("DB Read Error (Non-fatal):", e.message);
            }

            // 2. 🧠 AI GENERATION (Groq)
            if (!replyContent) {
                isNewQuestion = true;
                try {
                    replyContent = await getAIChatResponse([
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: msg.body }
                    ]);
                } catch (e) { 
                    console.error("AI Error:", e.message);
                    replyContent = "Network thoda busy hai, kripya dobara punche.";
                }
            }

            // 3. 📤 SEND REPLY (Text Only)
            if (chat) await chat.clearState();
            if (replyContent) {
                await msg.reply(replyContent);
            }

            // 4. 📦 LOGGING & ALERT
            if (isNewQuestion && userMsgClean.length > 5) {
                // Save to DB for Admin Review
                db.FAQ.create({
                    question: msg.body,
                    answer: replyContent,
                    audioUrl: "", // No Audio
                    voiceType: 'NONE',
                    status: 'PENDING_REVIEW',
                    isUserSubmitted: true
                }).catch(err => console.error("Log Save Error:", err.message));

                // Optional: Admin Alert on WhatsApp
                // sendAdminAlert(msg.body, replyContent); 
            }

        } catch (err) { 
            console.error('Bot Critical Error:', err.message); 
        }
    });

    client.initialize();
};

// 🔔 EXPORTABLE ADMIN ALERT FUNCTION
const sendAdminAlert = async (text, aiReply) => {
    if (!isReady || !client) return;
    try {
        const msg = `🚨 *New Query*\nQ: ${text}\nA: ${aiReply.substring(0, 100)}...`;
        await client.sendMessage(ADMIN_NUMBER, msg);
    } catch (e) {
        // Silent fail
    }
};

module.exports = { initializeWhatsAppBot, sendAdminAlert };