/**
 * @file rcm-ai-backend/scripts/testBusinessRAG.js
 * @description Verification script for Dynamic Business Knowledge RAG with DB Record Logging.
 */
require('dotenv').config();
const { generateTitanResponse, fetchBusinessKnowledge } = require('../services/aiService');

async function testRAG() {
    console.log("==================================================");
    console.log("🚀 TESTING DYNAMIC BUSINESS KNOWLEDGE BASE (RAG)");
    console.log("==================================================");

    const testUser = { fullName: "Ravi", pinLevel: "Distributor" };

    // Test 1: Royalty Bonus Query
    console.log("\n--- TEST 1: Royalty Bonus Query ---");
    const q1 = "Royalty bonus lene ke liye leg A aur leg B me kitna business chahiye?";
    console.log(`User: ${q1}`);
    const start1 = Date.now();
    const ragContext1 = await fetchBusinessKnowledge(q1);
    const duration1 = Date.now() - start1;
    console.log(`🔍 RAG Retrieved Context:\n${ragContext1 || "None"}\n`);
    const resp1 = await generateTitanResponse(testUser, q1, []);
    console.log(`AI Response:\n${resp1}\n⏱️ Latency: ${duration1}ms\n`);

    // Test 2: Technical Bonus Query
    console.log("--- TEST 2: Technical Bonus Query ---");
    const q2 = "Technical bonus ke liye Pearl aur Star Pearl me kitna PV chahiye?";
    console.log(`User: ${q2}`);
    const start2 = Date.now();
    const ragContext2 = await fetchBusinessKnowledge(q2);
    const duration2 = Date.now() - start2;
    console.log(`🔍 RAG Retrieved Context:\n${ragContext2 || "None"}\n`);
    const resp2 = await generateTitanResponse(testUser, q2, []);
    console.log(`AI Response:\n${resp2}\n⏱️ Latency: ${duration2}ms\n`);

    // Test 3: Consistency Bonus Query
    console.log("--- TEST 3: Consistency Bonus Query ---");
    const q3 = "Monthly consistency bonus me kitna free product milta hai?";
    console.log(`User: ${q3}`);
    const start3 = Date.now();
    const ragContext3 = await fetchBusinessKnowledge(q3);
    const duration3 = Date.now() - start3;
    console.log(`🔍 RAG Retrieved Context:\n${ragContext3 || "None"}\n`);
    const resp3 = await generateTitanResponse(testUser, q3, []);
    console.log(`AI Response:\n${resp3}\n⏱️ Latency: ${duration3}ms\n`);

    console.log("==================================================");
    console.log("✅ DYNAMIC RAG TEST COMPLETE");
    console.log("==================================================");
    process.exit(0);
}

testRAG().catch(err => {
    console.error("RAG Test Failed:", err);
    process.exit(1);
});
