const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { getAIChatResponse } = require('./aiService'); // AI Service Import
const { SYSTEM_PROMPT } = require('../utils/prompts'); // RCM Prompt

let client;

const initializeWhatsAppBot = () => {
    console.log("🔄 Initializing WhatsApp Bot...");

    // Render/Docker Environment ke liye configuration
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './auth_session' }), // Login session save karega
        puppeteer: {
            headless: true,
            // Dockerfile mein set kiye gaye path ka use karein
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu'
            ],
        }
    });

    // 1. QR Code Generate (Render Logs mein scan karein)
    client.on('qr', (qr) => {
        console.log('👇 SCAN THIS QR CODE TO CONNECT WHATSAPP 👇');
        qrcode.generate(qr, { small: true });
    });

    // 2. Ready Event
    client.on('ready', () => {
        console.log('✅ WhatsApp Bot is Online & Ready to Chat!');
    });

    // 3. Auth Failure Handling
    client.on('auth_failure', msg => {
        console.error('❌ WhatsApp Auth Failure:', msg);
    });

    // 4. Message Handling (Jab koi message bheje)
    client.on('message', async (msg) => {
        try {
            // Status Updates (Stories) aur Groups ko ignore karein
            if (msg.body === 'status@broadcast' || msg.from.includes('@g.us')) return;

            console.log(`📩 WhatsApp Msg from ${msg.from}: ${msg.body}`);

            // "Typing..." status dikhayein
            const chat = await msg.getChat();
            await chat.sendStateTyping();

            // --- AI Logic ---
            // AI ko context dene ke liye array banayein
            const messages = [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: msg.body }
            ];
            
            // AI se jawab maangein
            const aiRawResponse = await getAIChatResponse(messages);
            
            // Agar response JSON string hai toh usse clean text mein badlein
            let replyText = aiRawResponse;
            try {
                const json = JSON.parse(aiRawResponse);
                replyText = json.content || json.text || aiRawResponse;
            } catch (e) {
                // Agar JSON nahi hai toh direct text use karein
            }

            // Reply bhejein
            await msg.reply(replyText);
            
            // Typing status band karein
            await chat.clearState();

        } catch (err) {
            console.error('AI Reply Error:', err.message);
        }
    });

    client.initialize();
};

module.exports = { initializeWhatsAppBot };