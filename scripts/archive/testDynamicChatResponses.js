/**
 * @file rcm-ai-backend/scripts/testDynamicChatResponses.js
 * @description Script to test dynamic AI generation vs strict FAQ matching for various queries.
 */
require('dotenv').config();
const { generateTitanResponse } = require('../services/aiService');

async function runTest() {
    console.log("==================================================");
    console.log("🧪 TESTING DYNAMIC CHAT RESPONSES & STRICT FAQ");
    console.log("==================================================");

    const testUser = { fullName: "Leader", pinLevel: "Associate" };
    const queries = [
        "hi",
        "mera business kaisa chal raha hai batao",
        "sugar ke liye konsa product accha hai",
        "aap kon ho",
        "Aloe Vera Gel के फायदे बताओ"
    ];

    for (const q of queries) {
        console.log(`\n--------------------------------------------------`);
        console.log(`User Query: "${q}"`);
        const start = Date.now();
        const response = await generateTitanResponse(testUser, q, []);
        console.log(`AI Response (Length: ${response.length}):`);
        console.log(response);
        console.log(`Time taken: ${Date.now() - start}ms`);
    }

    console.log("\n==================================================");
    console.log("✅ DYNAMIC CHAT TEST COMPLETE");
    console.log("==================================================");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test Failed:", err);
    process.exit(1);
});
