/**
 * @file rcm-ai-backend/scripts/testComplexQuery.js
 * @description Test mixed/complex queries with and without PV data.
 */
require('dotenv').config();
const { generateTitanResponse } = require('../services/aiService');

async function runTest() {
    console.log("==================================================");
    console.log("🧪 COMPLEX QUERY TESTS (WITH & WITHOUT PV DATA)");
    console.log("==================================================");

    const testUser = { fullName: "Mohit", pinLevel: "Gold" };

    // Test 1: With complete PV data
    const queryWithData = "Mera self PV 3000 hai, Leg A 3.50 Lakh aur Leg B 1.15 Lakh hai. Mujhe Royalty bonus aur total calculation karke batao kitna milega?";
    console.log(`\n[Test 1] User Query: "${queryWithData}"`);
    const resp1 = await generateTitanResponse(testUser, queryWithData, []);
    console.log("--- Response 1 ---");
    console.log(resp1);
    console.log("------------------");

    // Test 2: Without PV data (Ambiguous calculation query)
    const queryWithoutData = "Mujhe royalty bonus calculate karke batao kitna milega?";
    console.log(`\n[Test 2] User Query: "${queryWithoutData}"`);
    const resp2 = await generateTitanResponse(testUser, queryWithoutData, []);
    console.log("--- Response 2 ---");
    console.log(resp2);
    console.log("------------------");

    const hasPlaceholder1 = /\[.*?\]/.test(resp1);
    const hasPlaceholder2 = /\[.*?\]/.test(resp2);

    if (hasPlaceholder1 || hasPlaceholder2) {
        console.log("❌ FAILURE: Placeholders found!");
    } else {
        console.log("✅ SUCCESS: No placeholders found in either response!");
    }

    console.log("==================================================");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test Failed:", err);
    process.exit(1);
});
