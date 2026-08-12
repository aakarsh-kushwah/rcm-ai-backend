/**
 * @file rcm-ai-backend/scripts/testComprehensiveMatrix.js
 * @description Comprehensive Test Suite covering 12+ AI response matrix scenarios.
 */
require('dotenv').config();
const { generateTitanResponse } = require('../services/aiService');

async function runMatrixTests() {
    console.log("==================================================================");
    console.log("🚀 STARTING TITAN ASI COMPREHENSIVE RESPONSE MATRIX TEST SUITE");
    console.log("==================================================================");

    const testUser = { fullName: "Ravi", pinLevel: "Associate" };
    
    const scenarios = [
        { category: "Greetings/Casual", query: "hi" },
        { category: "Greetings/Casual", query: "hello, kya haal hai" },
        { category: "Identity", query: "tum kaun ho" },
        { category: "Identity", query: "tumhe kisne banaya" },
        { category: "Business Knowledge - Single Topic", query: "Royalty bonus kya hai" },
        { category: "Business Knowledge - Single Topic", query: "Technical bonus kitna milta hai" },
        { category: "Business Knowledge - Mixed/Complex", query: "Agar mera PV 5 lakh hai aur dusra leg 2 lakh hai to kitna milega" },
        { category: "Ambiguous Business Query", query: "mera bonus kitna banega" },
        { category: "Product Query - General", query: "Aloe vera ke fayde" },
        { category: "Product Query - Symptom Based", query: "sugar ke liye kya lu" },
        { category: "Calculator Trigger", query: "calculator" },
        { category: "Memory / Follow-up", query: "Mera naam Ravi hai. (Follow up: Mera naam kya tha?)" },
        { category: "Off-topic / Unrelated", query: "aaj mausam kaisa hai" },
        { category: "Combined Query", query: "Royalty aur Technical dono explain karo" },
        { category: "Edge Case - Gibberish", query: "asdkjaskd ..." }
    ];

    const results = [];
    let history = [];

    for (let i = 0; i < scenarios.length; i++) {
        const sc = scenarios[i];
        console.log(`\n[${i+1}/${scenarios.length}] Testing [${sc.category}]: "${sc.query}"`);
        const start = Date.now();
        
        let q = sc.query;
        if (sc.query.includes("Follow up")) {
            history.push({ role: "user", content: "Mera naam Ravi hai." });
            history.push({ role: "assistant", content: "Namaste Ravi ji! Aapka swagat hai." });
            q = "Mera naam kya tha?";
        }

        try {
            const response = await generateTitanResponse(testUser, q, history);
            const duration = Date.now() - start;
            
            results.push({
                Category: sc.category,
                Query: sc.query,
                Response: response.substring(0, 100) + (response.length > 100 ? "..." : ""),
                Length: response.length,
                TimeMs: duration
            });

            console.log(`-> Response (${duration}ms): ${response}`);
        } catch (err) {
            console.error(`-> Error:`, err.message);
            results.push({
                Category: sc.category,
                Query: sc.query,
                Response: `ERROR: ${err.message}`,
                Length: 0,
                TimeMs: Date.now() - start
            });
        }
    }

    console.log("\n==================================================================");
    console.log("📊 COMPREHENSIVE AI RESPONSE MATRIX REPORT");
    console.log("==================================================================");
    console.table(results);
    console.log("==================================================================");
    process.exit(0);
}

runMatrixTests().catch(err => {
    console.error("Matrix Test Failed:", err);
    process.exit(1);
});
