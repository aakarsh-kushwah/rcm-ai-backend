/**
 * @file rcm-ai-backend/scripts/testPureRoyalty.js
 * @description Pure calculation test for calculateRoyaltyBonus with the new differential formula.
 */

const { calculateRoyaltyBonus } = require("../services/businessCalculator");

async function runPureTests() {
    console.log("=== RAW TEST OUTPUT FOR ROYALTY BONUS (DIFFERENTIAL FORMULA) ==-\n");

    const testCases = [
        { legA: 350000, legB: 115000 },
        { legA: 350000, legB: 170000 },
        { legA: 350000, legB: 260000 },
        { legA: 350000, legB: 350000 }
    ];

    for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const res = await calculateRoyaltyBonus(tc.legA, tc.legB);
        console.log(`Test Case ${i + 1}: calculateRoyaltyBonus(${tc.legA}, ${tc.legB})`);
        console.log(`  Tier: ${res.tier} (${res.percentage}%)`);
        console.log(`  Main Leg Bonus (legA * rate): ₹${res.mainLegBonus.toFixed(2)}`);
        console.log(`  Second Leg Bonus (legB * differential%): ₹${res.secondLegBonus.toFixed(2)}`);
        console.log(`  Total Royalty Bonus: ₹${res.bonus.toFixed(2)}`);
        console.log("--------------------------------------------------");
    }
}

runPureTests().catch(err => {
    console.error("Error running pure royalty tests:", err);
});
