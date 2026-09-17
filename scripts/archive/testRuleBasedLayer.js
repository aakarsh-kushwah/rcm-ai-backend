/**
 * @file rcm-ai-backend/scripts/testRuleBasedLayer.js
 * @description Comprehensive verification script for rule-based extraction layer (Royalty 5x, Technical 3x, Mixed 1x).
 */
require('dotenv').config();
const { generateTitanResponse } = require('../services/aiService');

async function runTests() {
    const testUser = { fullName: "Ravi", pinLevel: "Distributor" };

    console.log("==================================================");
    console.log("🚀 TESTING RULE-BASED EXTRACTION LAYER");
    console.log("==================================================\n");

    // 1. Royalty Bonus Solo Query (5 times)
    console.log("--- 1. ROYALTY BONUS SOLO QUERY (5 ATTEMPTS) ---");
    const qRoyalty = "Royalty bonus lene ke liye leg A aur leg B me kitna business chahiye?";
    for (let i = 1; i <= 5; i++) {
        const resp = await generateTitanResponse(testUser, qRoyalty, []);
        console.log(`[Royalty Attempt ${i}]:\n${resp}\n`);
    }

    // 2. Technical Bonus Solo Query (3 times)
    console.log("--- 2. TECHNICAL BONUS SOLO QUERY (3 ATTEMPTS) ---");
    const qTech = "Technical bonus ke liye leg A aur leg B me kitna requirement hai?";
    for (let i = 1; i <= 3; i++) {
        const resp = await generateTitanResponse(testUser, qTech, []);
        console.log(`[Technical Attempt ${i}]:\n${resp}\n`);
    }

    // 3. Mixed / Complex Calculation Query (1 time)
    console.log("--- 3. MIXED / COMPLEX CALCULATION QUERY ---");
    const qMixed = "Agar mera monthly group PV 12000 hai aur mujhe Royalty bonus aur Technical bonus dono ke bare me batao, toh calculation kaise hogi?";
    const respMixed = await generateTitanResponse(testUser, qMixed, []);
    console.log(`[Mixed Query Response]:\n${respMixed}\n`);

    console.log("==================================================");
    console.log("✅ ALL RULE-BASED & MIXED VERIFICATIONS COMPLETE");
    console.log("==================================================");
    process.exit(0);
}

runTests().catch(err => {
    console.error("Test Failed:", err);
    process.exit(1);
});
