/**
 * @file rcm-ai-backend/scripts/verifyMarketingPlanV3.js
 * @description Verification script for Marketing Plan V3 additions and consistency checks.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { generateTitanResponse, fetchBusinessKnowledge } = require("../services/aiService");

async function runVerification() {
    console.log("==================================================");
    console.log("🧪 MARKETING PLAN V3 VERIFICATION TESTS (EXTENDED)");
    console.log("==================================================");

    const testUser = { fullName: "Mohit", pinLevel: "Diamond" };

    // 1. Technical Bonus Tiers (Ruby, Sapphire, Diamond) - 3 Questions
    const techBonusQuestions = [
        "Technical bonus me Ruby tier ke liye leg A aur leg B me kitna business chahiye aur rate kya hai?",
        "Technical bonus me Sapphire tier ki requirement aur percentage kya hai?",
        "Technical bonus ke Diamond level par kitna PV aur rate milta hai?"
    ];

    for (let i = 0; i < techBonusQuestions.length; i++) {
        const q = techBonusQuestions[i];
        console.log(`\n--- TEST 1.${i + 1}: Technical Bonus Query ---`);
        console.log(`User Query: "${q}"`);
        const rag = await fetchBusinessKnowledge(q);
        console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${rag.rawMatch?.category} | Title: ${rag.rawMatch?.title}`);
        const resp = await generateTitanResponse(testUser, q, []);
        console.log(`--- Raw Response 1.${i + 1} ---`);
        console.log(resp);
        console.log("----------------------------------");
    }

    // 2. Growth Bonus Consistency Check (3 attempts)
    const qGrowth = "Monthly Royalty Growth Bonus kya hai aur isme points kaise milte hain?";
    console.log(`\n--- TEST 2: Growth Bonus Consistency Check (3 Attempts) ---`);
    for (let i = 0; i < 3; i++) {
        console.log(`--- Attempt ${i + 1} ---`);
        console.log(`User Query: "${qGrowth}"`);
        const ragGrowth = await fetchBusinessKnowledge(qGrowth);
        console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${ragGrowth.rawMatch?.category} | Title: ${ragGrowth.rawMatch?.title}`);
        const respGrowth = await generateTitanResponse(testUser, qGrowth, []);
        console.log(`--- Raw Response 2.${i + 1} ---`);
        console.log(respGrowth);
        console.log("----------------------------------");
    }

    // 3. Paint Bonus Consistency Check (3 attempts)
    const qPaint = "Paints Purchase Bonus kya hai aur iski kya eligibility hai?";
    console.log(`\n--- TEST 3: Paint Bonus Consistency Check (3 Attempts) ---`);
    for (let i = 0; i < 3; i++) {
        console.log(`--- Attempt ${i + 1} ---`);
        console.log(`User Query: "${qPaint}"`);
        const ragPaint = await fetchBusinessKnowledge(qPaint);
        console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${ragPaint.rawMatch?.category} | Title: ${ragPaint.rawMatch?.title}`);
        const respPaint = await generateTitanResponse(testUser, qPaint, []);
        console.log(`--- Raw Response 3.${i + 1} ---`);
        console.log(respPaint);
        console.log("----------------------------------");
    }

    // 4. Missing Verification - Performance Bonus
    const qPerformance = "Performance Bonus ke slabs aur differential calculation ke baare mein batao.";
    console.log(`\n--- TEST 4: Performance Bonus Query ---`);
    console.log(`User Query: "${qPerformance}"`);
    const ragPerformance = await fetchBusinessKnowledge(qPerformance);
    console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${ragPerformance.rawMatch?.category} | Title: ${ragPerformance.rawMatch?.title}`);
    const respPerformance = await generateTitanResponse(testUser, qPerformance, []);
    console.log(`--- Raw Response 4 ---`);
    console.log(respPerformance);
    console.log("----------------------------------");

    // 5. Missing Verification - Consistency Bonus (Updated)
    const qConsistency = "Monthly Consistency Reward Plan ke naye rules kya hain, especially shortfall aur free products ke baare mein?";
    console.log(`\n--- TEST 5: Consistency Bonus (Updated) Query ---`);
    console.log(`User Query: "${qConsistency}"`);
    const ragConsistency = await fetchBusinessKnowledge(qConsistency);
    console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${ragConsistency.rawMatch?.category} | Title: ${ragConsistency.rawMatch?.title}`);
    const respConsistency = await generateTitanResponse(testUser, qConsistency, []);
    console.log(`--- Raw Response 5 ---`);
    console.log(respConsistency);
    console.log("----------------------------------");

    // 6. Missing Verification - Royalty Bonus (New rules: 2500 PV, WWQ meetings)
    const qRoyaltyNewRules = "Royalty Bonus ke naye eligibility rules kya hain, jaise personal PV aur meetings ke liye?";
    console.log(`\n--- TEST 6: Royalty Bonus (New Rules) Query ---`);
    console.log(`User Query: "${qRoyaltyNewRules}"`);
    const ragRoyaltyNewRules = await fetchBusinessKnowledge(qRoyaltyNewRules);
    console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${ragRoyaltyNewRules.rawMatch?.category} | Title: ${ragRoyaltyNewRules.rawMatch?.title}`);
    const respRoyaltyNewRules = await generateTitanResponse(testUser, qRoyaltyNewRules, []);
    console.log(`--- Raw Response 6 ---`);
    console.log(respRoyaltyNewRules);
    console.log("----------------------------------");

    // 7. Missing Verification - Vital Level Pin Chart
    const qVitalPin = "Vital Level Pin Chart me Opener aur Star level ke liye kitna Total PV aur Min Other Group PV chahiye?";
    console.log(`\n--- TEST 7: Vital Level Pin Chart Query ---`);
    console.log(`User Query: "${qVitalPin}"`);
    const ragVitalPin = await fetchBusinessKnowledge(qVitalPin);
    console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${ragVitalPin.rawMatch?.category} | Title: ${ragVitalPin.rawMatch?.title}`);
    const respVitalPin = await generateTitanResponse(testUser, qVitalPin, []);
    console.log(`--- Raw Response 7 ---`);
    console.log(respVitalPin);
    console.log("----------------------------------");

    // 8. Missing Verification - Pin Level Income Chart (20-level)
    const qPinIncome = "RCM ka Pin Level Income & Milestone Chart me Gold aur Diamond levels ke baare mein batao.";
    console.log(`\n--- TEST 8: Pin Level Income Chart (20-level) Query ---`);
    console.log(`User Query: "${qPinIncome}"`);
    const ragPinIncome = await fetchBusinessKnowledge(qPinIncome);
    console.log(`🔍 [CONSOLE LOG] RAG Match Category: ${ragPinIncome.rawMatch?.category} | Title: ${ragPinIncome.rawMatch?.title}`);
    const respPinIncome = await generateTitanResponse(testUser, qPinIncome, []);
    console.log(`--- Raw Response 8 ---`);
    console.log(respPinIncome);
    console.log("----------------------------------");

    console.log("==================================================");
    console.log("✅ ALL VERIFICATION TESTS COMPLETE (EXTENDED)");
    console.log("==================================================");
    process.exit(0);
}

runVerification().catch(err => {
    console.error("Verification Failed:", err);
    process.exit(1);
});
