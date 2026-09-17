/**
 * @file rcm-ai-backend/scripts/debugChatMessages.js
 * @description Debug script for chat messages and chat history queries.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize, ChatMessage, User } = require('../models');

async function debugChat() {
    try {
        await sequelize.authenticate();
        console.log("=== DB CONNECTED ===");

        const { generateTitanResponse } = require('../services/aiService');

        console.log("\n=== AI RESPONSE 1 ===");
        const r1 = await generateTitanResponse({ fullName: 'Ravi', pinLevel: 'Associate' }, '__WELCOME__', []);
        console.log(r1.response);

        console.log("\n=== AI RESPONSE 2 ===");
        const r2 = await generateTitanResponse({ fullName: 'Ravi', pinLevel: 'Associate' }, 'Technical bonus kaise milta hai', []);
        console.log(r2.response);

        await sequelize.close();
        process.exit(0);
    } catch (err) {
        console.error("Debug error:", err);
        process.exit(1);
    }
}

debugChat();
