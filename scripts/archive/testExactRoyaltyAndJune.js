/**
 * @file rcm-ai-backend/scripts/testExactRoyaltyAndJune.js
 * @description Script to output exact raw results for the requested Royalty test cases and June real case.
 */

require("dotenv").config({
    path: require("path").resolve(__dirname, "../../.env"),
});

const { connectDB, sequelize } = require("../models");
const { calculateRoyaltyBonus, calculateTechnicalBonus, calculatePerformanceBonus } = require("../services/businessCalculator");

async function runExactTests() {
    await connectDB();

    console.log("=== EXACT ROYALTY TEST CASES ===");
    
    // 1. calculateRoyaltyBonus(350000, 115000)
    const r1 = await calculateRoyaltyBonus(350000, 115000);
    console.log(`1. calculateRoyaltyBonus(350000, 115000):`);
    console.log(`   Tier: ${r1.tier} (${r1.percentage}%)`);
    console.log(`   Main Leg: 350000 | Second Leg: 115000`);
    console.log(`   Bonus: ₹${r1.bonus.toFixed(2)}`);

    // 2. calculateRoyaltyBonus(350000, 170000)
    const r2 = await calculateRoyaltyBonus(350000, 170000);
    console.log(`2. calculateRoyaltyBonus(350000, 170000):`);
    console.log(`   Tier: ${r2.tier} (${r2.percentage}%)`);
    console.log(`   Main Leg: 350000 | Second Leg: 170000`);
    console.log(`   Bonus: ₹${r2.bonus.toFixed(2)}`);

    // 3. calculateRoyaltyBonus(350000, 260000)
    const r3 = await calculateRoyaltyBonus(350000, 260000);
    console.log(`3. calculateRoyaltyBonus(350000, 260000):`);
    console.log(`   Tier: ${r3.tier} (${r3.percentage}%)`);
    console.log(`   Main Leg: 350000 | Second Leg: 260000`);
    console.log(`   Bonus: ₹${r3.bonus.toFixed(2)}`);

    // 4. calculateRoyaltyBonus(350000, 350000)
    const r4 = await calculateRoyaltyBonus(350000, 350000);
    console.log(`4. calculateRoyaltyBonus(350000, 350000):`);
    console.log(`   Tier: ${r4.tier} (${r4.percentage}%)`);
    console.log(`   Main Leg: 350000 | Second Leg: 350000`);
    console.log(`   Bonus: ₹${r4.bonus.toFixed(2)}`);

    console.log("\n=== JUNE 2026 REAL CASE (Self 1518, Leg A 1734293, Leg B 700170) ===");
    const legA = 1734293;
    const legB = 700170;
    const self = 1518;

    const perf = await calculatePerformanceBonus(self);
    const juneRoyalty = await calculateRoyaltyBonus(legA, legB);
    const juneTech = await calculateTechnicalBonus(legA, legB);

    const gross = perf + juneRoyalty.bonus + juneTech.bonus;
    const tds = gross * 0.02;
    const net = gross - tds;

    console.log(`Performance Bonus (Self 1518 PV): ₹${perf.toFixed(2)}`);
    console.log(`Royalty Bonus (${juneRoyalty.tier} @ ${juneRoyalty.percentage}%): ₹${juneRoyalty.bonus.toFixed(2)}`);
    console.log(`Technical Bonus (${juneTech.tier} @ ${juneTech.percentage}%): ₹${juneTech.bonus.toFixed(2)}`);
    console.log(`Gross Commission: ₹${gross.toFixed(2)}`);
    console.log(`TDS (2%): ₹${tds.toFixed(2)}`);
    console.log(`Net Payable: ₹${net.toFixed(2)}`);

    await sequelize.close();
    process.exit(0);
}

runExactTests();
