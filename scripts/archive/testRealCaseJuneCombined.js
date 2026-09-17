/**
 * @file rcm-ai-backend/scripts/testRealCaseJuneCombined.js
 * @description Comprehensive test script for June 2026 real case including Performance, Royalty, and Technical bonuses.
 */

require("dotenv").config({
    path: require("path").resolve(__dirname, "../../.env"),
});

const { connectDB, sequelize } = require("../models");
const { 
    calculatePerformanceBonus, 
    calculateRoyaltyBonus, 
    calculateTechnicalBonus, 
    getPinLevel 
} = require("../services/businessCalculator");

async function runCombinedTest() {
    await connectDB();
    console.log("Database Connected for Combined Real Case Test.");

    try {
        const legA_PV = 1734293;
        const legB_PV = 700170;
        const selfPV = 1518;
        const totalPV = 2435981;

        console.log(`\n========================================`);
        console.log(`📊 JUNE 2026 COMPREHENSIVE BONUS PREDICTION`);
        console.log(`========================================`);
        console.log(`Self PV : ${selfPV}`);
        console.log(`Leg A PV: ${legA_PV}`);
        console.log(`Leg B PV: ${legB_PV}`);
        console.log(`Total PV: ${totalPV}`);

        // 1. Pin Level
        const pin = await getPinLevel(legA_PV, legB_PV);
        console.log(`\n🏆 Matched Pin Level: ${pin.level} (Income Range: ${pin.incomeRange})`);

        // 2. Performance Bonus on Self
        const perfBonus = await calculatePerformanceBonus(selfPV);
        console.log(`\n1️⃣ Performance Bonus (Self @ 1518 PV): ₹${perfBonus.toFixed(2)}`);

        // 3. Royalty Bonus (Star Platinum tier: 3.5L / 3.5L -> 8%)
        const royaltyResult = await calculateRoyaltyBonus(legA_PV, legB_PV);
        console.log(`\n2️⃣ Royalty Bonus:`);
        console.log(`   Tier: ${royaltyResult.tier}`);
        console.log(`   Percentage: ${royaltyResult.percentage}%`);
        console.log(`   Bonus: ₹${royaltyResult.bonus.toFixed(2)}`);

        // 4. Technical Bonus (Pearl Tier: 1%)
        const techResult = await calculateTechnicalBonus(legA_PV, legB_PV);
        console.log(`\n3️⃣ Technical Bonus:`);
        console.log(`   Tier: ${techResult.tier}`);
        console.log(`   Percentage: ${techResult.percentage}%`);
        console.log(`   Bonus: ₹${techResult.bonus.toFixed(2)}`);

        // Gross Commission Breakdown
        const grossCommission = perfBonus + royaltyResult.bonus + techResult.bonus;
        console.log(`\n----------------------------------------`);
        console.log(`💰 FINANCIAL SUMMARY:`);
        console.log(`   Performance Bonus : ₹${perfBonus.toFixed(2)}`);
        console.log(`   Royalty Bonus     : ₹${royaltyResult.bonus.toFixed(2)}`);
        console.log(`   Technical Bonus   : ₹${techResult.bonus.toFixed(2)}`);
        console.log(`   -------------------------------------`);
        console.log(`   Gross Commission  : ₹${grossCommission.toFixed(2)}`);

        // TDS & Net Payable
        const tds = grossCommission * 0.02;
        const netPayable = grossCommission - tds;
        console.log(`   TDS (2%)          : ₹${tds.toFixed(2)}`);
        console.log(`   Net Payable       : ₹${netPayable.toFixed(2)}`);
        console.log(`========================================`);

    } catch (error) {
        console.error("Combined Test Error:", error);
    } finally {
        await sequelize.close();
        console.log("Database Connection Closed.");
    }
}

runCombinedTest();
