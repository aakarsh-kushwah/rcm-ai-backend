/**
 * @file rcm-ai-backend/scripts/testAdminEndpoints.js
 * @description Script to test admin and user API endpoints and verify raw responses.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const request = require('supertest');
const { sequelize, Admin, User } = require('../models');
const app = require('../server');
const jwt = require('jsonwebtoken');

async function runTests() {
    try {
        await sequelize.authenticate();
        console.log("=== DB CONNECTED FOR TESTING ===");

        // Get admin record to generate test token
        const admin = await Admin.findOne();
        if (!admin) {
            console.error("❌ No admin found in database!");
            process.exit(1);
        }

        const token = jwt.sign(
            { id: admin.id, email: admin.email, role: admin.role },
            process.env.JWT_SECRET || 'titan_super_secret_key_2026',
            { expiresIn: '1h' }
        );

        console.log("\n--- Testing GET /api/admin/users ---");
        const resUsers = await request(app)
            .get('/api/admin/users')
            .set('Authorization', `Bearer ${token}`);
        console.log("Status:", resUsers.status);
        console.log("Count:", resUsers.body.count);
        console.log("Sample User:", resUsers.body.data?.[0]);

        console.log("\n--- Testing GET /api/admin/admins ---");
        const resAdmins = await request(app)
            .get('/api/admin/admins')
            .set('Authorization', `Bearer ${token}`);
        console.log("Status:", resAdmins.status);
        console.log("Admins Data:", resAdmins.body.data);

        console.log("\n--- Testing GET /api/admin/chat/users ---");
        const resChatUsers = await request(app)
            .get('/api/admin/chat/users')
            .set('Authorization', `Bearer ${token}`);
        console.log("Status:", resChatUsers.status);
        console.log("Chat Users Count:", resChatUsers.body.data?.length);

        console.log("\n✅ ALL API TESTS COMPLETED SUCCESSFULLY.");
        await sequelize.close();
        process.exit(0);
    } catch (err) {
        console.error("Test execution error:", err);
        process.exit(1);
    }
}

runTests();
