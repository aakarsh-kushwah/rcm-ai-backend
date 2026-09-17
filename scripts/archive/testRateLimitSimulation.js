/**
 * @file rcm-ai-backend/scripts/testRateLimitSimulation.js
 * @description Simulation script to verify 429 rate limit retry logic and graceful fallback message.
 */
require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.SIMULATE_429 = 'true';
const { generateTitanResponse } = require('../services/aiService');

async function runRateLimitSimulation() {
    console.log("==================================================");
    console.log("🚀 STARTING RATE LIMIT (429) & RETRY SIMULATION");
    console.log("==================================================");

    const testUser = { fullName: "Ravi", pinLevel: "Associate" };
    
    // We will test with a message that triggers generation
    const msg = "Technical bonus kaise milta hai";
    console.log(`User Query: ${msg}`);
    console.log("Simulating API call under rate limit condition...\n");

    const response = await generateTitanResponse(testUser, msg, []);
    console.log(`\nFinal AI Response Received:\n"${response}"`);

    console.log("==================================================");
    console.log("✅ RATE LIMIT SIMULATION COMPLETE");
    console.log("==================================================");
    process.exit(0);
}

runRateLimitSimulation().catch(err => {
    console.error("Simulation Failed:", err);
    process.exit(1);
});
