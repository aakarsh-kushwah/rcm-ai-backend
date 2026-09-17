/**
 * @file rcm-ai-backend/scripts/testDetailedRawVerification.js
 * @description Detailed verification script to output exact raw responses for Calculator Memory and 6 key scenarios.
 */
require('dotenv').config();
const { generateTitanResponse } = require('../services/aiService');

async function runDetailedVerification() {
    console.log("==================================================");
    console.log("🔍 DETAILED RAW VERIFICATION REPORT");
    console.log("==================================================");

    const testUser = { fullName: "Ravi", pinLevel: "Associate" };

    // 1. Calculator Memory Test
    console.log("\n--- [TEST A] Calculator Memory & Follow-up ---");
    let calcHistory = [
        { role: "user", content: "Calculate: Self PV 5000, Leg A PV 350000, Leg B PV 115000" },
        { role: "assistant", content: JSON.stringify({
            type: "calculator_widget",
            data: {
                selfPurchasePv: 5000,
                legAPv: 350000,
                legBPv: 115000,
                performanceBonus: 1600,
                royaltyBonus: 10500,
                technicalBonus: 0,
                grossIncome: 12100,
                netPayable: 11858,
                pinLevel: "Gold"
            }
        })}
    ];
    // Simulate AI processing the widget data into a readable format for context
    calcHistory.push({ role: "assistant", content: "System: User ne calculator use kiya - Self PV 5000, Leg A PV 350000, Leg B PV 115000 daala, result: Performance ₹1600, Royalty ₹10500, Technical ₹0, Net Payable ₹11858 aaya. Pin Level: Gold." });

    const q1 = "isme Technical Bonus kitna tha?";
    console.log(`User Query: "${q1}"`);
    const start1 = Date.now();
    const resp1 = await generateTitanResponse(testUser, q1, calcHistory);
    console.log(`Exact Raw AI Response (${Date.now() - start1}ms):\n${resp1}`);

    // 2. 6 Key Scenarios
    const scenarios = [
        "hi",
        "mera bonus kitna banega",
        "sugar ke liye kya lu",
        "Royalty aur Technical dono explain karo",
        "aaj mausam kaisa hai"
    ];

    let memHistory = [];
    // First message for memory test
    console.log("\n--- [TEST B.6] Memory Test - Part 1: Name Introduction ---");
    const nameIntroQuery = "Mera naam Ravi hai.";
    console.log(`User Query: "${nameIntroQuery}"`);
    const startNameIntro = Date.now();
    const nameIntroResp = await generateTitanResponse(testUser, nameIntroQuery, memHistory);
    console.log(`Exact Raw AI Response (${Date.now() - startNameIntro}ms):\n${nameIntroResp}`);
    memHistory.push({ role: "user", content: nameIntroQuery });
    memHistory.push({ role: "assistant", content: nameIntroResp });

    // Simulate 3 intervening messages (or just add dummy entries to history)
    memHistory.push({ role: "user", content: "Kuch aur sawal tha." });
    memHistory.push({ role: "assistant", content: "Poochiye ji, main yahan hoon." });
    memHistory.push({ role: "user", content: "Theek hai." });
    memHistory.push({ role: "assistant", content: "Aur koi sawal?" });

    for (let i = 0; i < scenarios.length; i++) {
        let q = scenarios[i];
        console.log(`\n--- [TEST B.${i+1}] Scenario: "${q}" ---`);
        const start = Date.now();
        const resp = await generateTitanResponse(testUser, q, []); // Use fresh history for non-memory tests
        console.log(`Exact Raw AI Response (${Date.now() - start}ms):\n${resp}`);
    }

    console.log("\n--- [TEST B.6] Memory Test - Part 2: Name Recall ---");
    const nameRecallQuery = "Mera naam kya tha?";
    console.log(`User Query: "${nameRecallQuery}"`);
    const startNameRecall = Date.now();
    const nameRecallResp = await generateTitanResponse(testUser, nameRecallQuery, memHistory);
    console.log(`Exact Raw AI Response (${Date.now() - startNameRecall}ms):\n${nameRecallResp}`);

    console.log("\n==================================================");
    console.log("✅ DETAILED RAW VERIFICATION COMPLETE");
    console.log("==================================================");
    process.exit(0);
}

runDetailedVerification().catch(err => {
    console.error("Verification Failed:", err);
    process.exit(1);
});
