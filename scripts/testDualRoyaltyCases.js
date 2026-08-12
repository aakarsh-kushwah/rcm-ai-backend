/**
 * @file rcm-ai-backend/scripts/testDualRoyaltyCases.js
 * @description Test script verifying both Yash Kushwah case and June 2026 case with the refined royalty bonus rule.
 */

const { calculateRoyaltyBonus } = require("../services/businessCalculator");

async function runDualTests() {
    console.log("==================================================================");
    console.log("📊 DUAL CASE ROYALTY BONUS VERIFICATION (YASH & JUNE)");
    console.log("==================================================================");

    // Case 1: Yash Kushwah Case
    // Leg A: 476444, Leg B: 214196 (Second leg < 350000)
    // Expected Royalty: ₹21,440 (476444 * 4.5% Star Gold)
    const yashResult = await calculateRoyaltyBonus(476444, 214196);
    
    // Case 2: June 2026 Case (Leeldhar Kushwah)
    // Leg A: 1734291, Leg B: 700170 (Both legs >= 350000)
    // Expected Royalty: Close to ₹41,790
    const juneResult = await calculateRoyaltyBonus(1734291, 700170);

    console.log("\n--- TEST RESULTS ---");
    console.log(`1. Yash Case (476444, 214196):`);
    console.log(`   Tier: ${yashResult.tier} (${yashResult.percentage}%)`);
    console.log(`   Main Leg Bonus: ₹${yashResult.mainLegBonus.toFixed(2)}`);
    console.log(`   Second Leg Bonus: ₹${yashResult.secondLegBonus.toFixed(2)}`);
    console.log(`   Total Royalty Bonus: ₹${yashResult.bonus.toFixed(2)} (Actual: ₹21,440.00)`);

    console.log(`\n2. June Case (1734291, 700170):`);
    console.log(`   Tier: ${juneResult.tier} (${juneResult.percentage}%)`);
    console.log(`   Main Leg Bonus: ₹${juneResult.mainLegBonus.toFixed(2)}`);
    console.log(`   Second Leg Bonus: ₹${juneResult.secondLegBonus.toFixed(2)}`);
    console.log(`   Total Royalty Bonus: ₹${juneResult.bonus.toFixed(2)} (Actual: ₹41,790.00). Aap dono legs se independently Royalty-qualify kar rahe hain - yeh ek advanced scenario hai jiska exact calculation abhi confirm nahi hua hai. Approximate estimate: ₹${juneResult.bonus.toFixed(2)}, lekin exact amount ke liye apna Monthly Statement check karein.`);

    console.log("\n==================================================================");
    console.log("📋 COMPARISON TABLE");
    console.log("==================================================================");
    console.log("Case Name          | Predicted Royalty    | Real / Expected     | Match?");
    console.log("------------------------------------------------------------------");
    console.log(`Yash Case          | ₹${yashResult.bonus.toFixed(2).padEnd(20)} | ₹21,440.00          | ${Math.abs(yashResult.bonus - 21440) < 5 ? "MATCH ✅" : "MISMATCH ❌"}`);
    console.log(`June Case          | ₹${juneResult.bonus.toFixed(2).padEnd(20)} | ₹41,790.00          | ${Math.abs(juneResult.bonus - 41790) < 1000 ? "CLOSE MATCH / CHECK" : "MISMATCH ❌"}`);
    console.log("==================================================================");
}

runDualTests().catch(console.error);
