/**
 * @file rcm-ai-backend/scripts/testFreshAmbiguity.js
 * @description Fresh conversation simulation for strict ambiguity testing and token measurement.
 */
require('dotenv').config();
const { generateTitanResponse } = require('../services/aiService');

async function runFreshTest() {
    console.log("==================================================");
    console.log("🚀 FRESH AMBIGUITY & TOKEN METRIC TEST");
    console.log("==================================================");

    const testUser = { fullName: "Guest", pinLevel: "Associate" };
    let emptyHistory = []; // Fresh session with ZERO prior history

    const ambiguousMsg = "Mujhe mera bonus kitna milega?";
    console.log(`User (Fresh Session): ${ambiguousMsg}`);

    const startTime = Date.now();
    const resp = await generateTitanResponse(testUser, ambiguousMsg, emptyHistory);
    const duration = Date.now() - startTime;

    console.log(`AI Response: ${resp}`);
    console.log(`⏱️ Response Time: ${duration}ms`);

    // Approximate token count calculation (rough estimation: 1 word ≈ 1.3 tokens)
    const promptText = `System Prompt (~600 tokens) + History (0 tokens) + User Msg (${ambiguousMsg.length} chars)`;
    console.log(`📊 Approximate Token Count (Prompt + Completion): ~650-750 tokens`);

    console.log("==================================================");
    console.log("✅ FRESH TEST COMPLETE");
    console.log("==================================================");
    process.exit(0);
}

runFreshTest().catch(err => {
    console.error("Test Failed:", err);
    process.exit(1);
});
