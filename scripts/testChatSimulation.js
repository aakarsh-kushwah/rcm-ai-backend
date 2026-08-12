/**
 * @file rcm-ai-backend/scripts/testChatSimulation.js
 * @description Simulation script to test conversation memory, calculation reasoning, and ambiguity handling.
 */
require('dotenv').config();
const { generateTitanResponse } = require('../services/aiService');
const db = require('../models');

async function runSimulation() {
    console.log("==================================================");
    console.log("🚀 STARTING TITAN ASI SIMULATION & VERIFICATION");
    console.log("==================================================");

    const testUser = { fullName: "Ravi", pinLevel: "Associate" };
    let history = [];

    // Test 1: Context Memory Setup
    console.log("\n--- TEST 1: Context Memory Setup ---");
    const msg1 = "Mera naam Ravi hai aur mera self PV 500 hai.";
    console.log(`User: ${msg1}`);
    const resp1 = await generateTitanResponse(testUser, msg1, history);
    console.log(`AI: ${resp1}\n`);

    history.push({ role: "user", content: msg1 });
    history.push({ role: "assistant", content: resp1 });

    // Test 2: Memory Recall
    console.log("--- TEST 2: Memory Recall ---");
    const msg2 = "Mera naam kya tha aur mera PV kitna bataya tha maine?";
    console.log(`User: ${msg2}`);
    const resp2 = await generateTitanResponse(testUser, msg2, history);
    console.log(`AI: ${resp2}\n`);

    history.push({ role: "user", content: msg2 });
    history.push({ role: "assistant", content: resp2 });

    // Test 3: Complex Calculation with Reasoning
    console.log("--- TEST 3: Complex Calculation (Step-by-Step Reasoning) ---");
    const msg3 = "Agar mera monthly group PV 12000 hai to mera performance bonus kitna banega?";
    console.log(`User: ${msg3}`);
    const resp3 = await generateTitanResponse(testUser, msg3, history);
    console.log(`AI: ${resp3}\n`);

    history.push({ role: "user", content: msg3 });
    history.push({ role: "assistant", content: resp3 });

    // Test 4: Ambiguity Handling
    console.log("--- TEST 4: Ambiguity Handling (Missing PV/BV) ---");
    const msg4 = "Mujhe mera bonus kitna milega?";
    console.log(`User: ${msg4}`);
    const resp4 = await generateTitanResponse(testUser, msg4, history);
    console.log(`AI: ${resp4}\n`);

    console.log("==================================================");
    console.log("✅ SIMULATION COMPLETE - ALL TESTS EXECUTED");
    console.log("==================================================");
    // Test 5: Technical Bonus Explanation
    console.log("\n--- TEST 5: Technical Bonus Explanation ---");
    const msg5 = "Technical bonus kaise milta hai";
    console.log(`User: ${msg5}`);
    const resp5 = await generateTitanResponse(testUser, msg5, history);
    console.log(`AI: ${resp5}\n`);

    history.push({ role: "user", content: msg5 });
    history.push({ role: "assistant", content: resp5 });

    // Test 6: Technical Bonus Zero Explanation
    console.log("--- TEST 6: Technical Bonus Zero Explanation (Self PV Met, Legs not) ---");
    const msg6 = "mera Technical Bonus 0 kyun aaya jabki self PV 5000 hai";
    console.log(`User: ${msg6}`);
    // For this specific test, let's assume specific PVs for accurate simulation, even if history has general data.
    // The AI should primarily use the prompt instructions for general explanations or the zero bonus rule.
    const testUserWithPV = { fullName: "Ravi", pinLevel: "Associate", selfPurchasePv: 5000, legAPv: 100000, legBPv: 80000 }; // Legs are below 5L
    const resp6 = await generateTitanResponse(testUserWithPV, msg6, history);
    console.log(`AI: ${resp6}\n`);

    // Test 7: Fresh Welcome Message
    console.log("\n--- TEST 7: Fresh Welcome Message ---");
    const msg7 = "__WELCOME__";
    console.log(`User: ${msg7}`);
    const resp7 = await generateTitanResponse(testUser, msg7, []);
    console.log(`AI: ${resp7}\n`);

    console.log("==================================================");
    console.log("✅ SIMULATION COMPLETE - ALL TESTS EXECUTED");
    console.log("==================================================");
    process.exit(0);
}

runSimulation().catch(err => {
    console.error("Simulation Failed:", err);
    process.exit(1);
});
