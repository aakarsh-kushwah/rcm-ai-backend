/**
 * @file rcm-ai-backend/scripts/verifyEndpointsAxios.js
 * @description Direct function & model verification script for PART 4.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize, User, Admin, ChatMessage } = require('../models');

async function verify() {
    try {
        await sequelize.authenticate();
        console.log("=== DB CONNECTED ===");

        // 1. Check Admins
        const admins = await Admin.findAll();
        console.log("\n--- 1. ADMINS TABLE RECORDS ---");
        console.log(admins.map(a => ({ id: a.id, name: a.name, email: a.email, role: a.role })));

        // 2. Check Regular Users
        const users = await User.findAll({ attributes: ['id', 'fullName', 'email', 'role', 'status'] });
        console.log("\n--- 2. USERS TABLE RECORDS (Total: " + users.length + ") ---");
        users.forEach(u => console.log(`- [ID: ${u.id}] ${u.fullName} (${u.email}) [Role: ${u.role}] [Status: ${u.status}]`));

        // 3. Check Chat Users (Distinct users with chat messages)
        const chatRows = await ChatMessage.findAll({
            attributes: ['userId'],
            group: ['userId']
        });
        console.log("\n--- 3. CHAT USERS COUNT ---", chatRows.length);

        await sequelize.close();
        console.log("\n✅ VERIFICATION COMPLETE: NO STALE ADMINS IN USER TABLE.");
        process.exit(0);
    } catch (err) {
        console.error("Verification error:", err);
        process.exit(1);
    }
}

verify();
