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

        // 1. Show all chat messages count and samples
        const [allMsgs] = await sequelize.query("SELECT * FROM chat_messages LIMIT 10;");
        console.log(`\n--- Total messages in chat_messages table ---`);
        console.log("Count:", allMsgs.length);
        console.log("Samples:", allMsgs);

        // 2. Check chat users
        const [chatUsers] = await sequelize.query(`
            SELECT userId, COUNT(*) as msgCount 
            FROM chat_messages 
            GROUP BY userId;
        `);
        console.log("\n--- Users with chat messages ---");
        console.log(chatUsers);

        // 3. Test query for a specific user if exists
        if (chatUsers.length > 0) {
            const sampleUserId = chatUsers[0].userId;
            console.log(`\n--- Testing fetch for userId: ${sampleUserId} ---`);
            const userMsgs = await ChatMessage.findAll({ where: { userId: sampleUserId } });
            console.log("Fetched messages:", userMsgs.length);
        }

        await sequelize.close();
        process.exit(0);
    } catch (err) {
        console.error("Debug error:", err);
        process.exit(1);
    }
}

debugChat();
