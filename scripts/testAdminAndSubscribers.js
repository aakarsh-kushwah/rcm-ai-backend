require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { connectDB } = require('../config/db');
const { User, Subscriber } = require('../models');

async function runTest() {
    try {
        await connectDB();
        console.log("=== TEST 1: Fetching Regular Users (UserManagement / ChatViewer) ===");
        const users = await User.findAll({
            where: { role: { [require('sequelize').Op.ne]: 'ADMIN' } },
            attributes: ['id', 'fullName', 'email', 'role', 'status', 'createdAt'],
            limit: 5
        });
        console.log("RAW_RESPONSE_USERS:", JSON.stringify({ success: true, count: users.length, data: users }, null, 2));

        console.log("=== TEST 2: Fetching Subscribers (SubscriberList) ===");
        const subscribers = await Subscriber.findAll({
            limit: 5
        });
        console.log("RAW_RESPONSE_SUBSCRIBERS:", JSON.stringify({ success: true, count: subscribers.length, data: subscribers }, null, 2));

        process.exit(0);
    } catch (err) {
        console.error("TEST FAILED:", err);
        process.exit(1);
    }
}

runTest();
