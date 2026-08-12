/**
 * @file scripts/verifyAll.js
 * @description Raw verification output script for admins, chat, videos, and notifications.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { sequelize } = require("../config/db");

async function verifyAll() {
    try {
        await sequelize.authenticate();
        console.log("=== ADMIN TABLE VERIFICATION ===");
        const [countResult] = await sequelize.query("SELECT COUNT(*) AS count FROM admins;");
        console.log("Count:", countResult[0]);

        const [adminRows] = await sequelize.query("SELECT id, email, role FROM admins;");
        console.log("Admin Rows:", JSON.stringify(adminRows, null, 2));

        console.log("\n=== CHAT MESSAGES VERIFICATION ===");
        const [chatRows] = await sequelize.query("SELECT id, userId, sender, message FROM chat_messages LIMIT 3;");
        console.log("Chat Messages Sample:", JSON.stringify(chatRows, null, 2));

        console.log("\n=== VIDEOS VERIFICATION ===");
        const [videoRows] = await sequelize.query("SELECT id, title, video_url FROM product_videos LIMIT 3;");
        console.log("Product Videos Sample:", JSON.stringify(videoRows, null, 2));

    } catch (error) {
        console.error("Verification Error:", error.message);
    } finally {
        await sequelize.close();
    }
}

verifyAll();
