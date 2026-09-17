/**
 * @file rcm-ai-backend/scripts/testRealCaseJune.js
 * @description Real case test script for June 2026 data.
 */

require("dotenv").config({
    path: require("path").resolve(__dirname, "../../.env"),
});

const { connectDB, sequelize } = require("../models");
const { calculateTechnicalBonus } = require("../services/businessCalculator");

async function runRealTest() {
    await connectDB();
    console.log("Database Connected for Real Case Test.");

    try {
        const legA_PV = 1734293;
        const legB_PV = 700170;
        const selfPV = 1518;
        const totalPV = 2435981;

        console.log(`\n--- June 2026 Real Case Test ---`);
        console.log(`Self PV: ${selfPV}`);
        console.log(`Leg A PV: ${legA_PV}`);
        console.log(`Leg B PV: ${legB_PV}`);
        console.log(`Total PV: ${totalPV}`);

        // 1. Technical Bonus Calculation (Pearl Tier: 1%)
        const techResult = await calculateTechnicalBonus(legA_PV, legB_PV);
        console.log(`\n1. Technical Bonus Result:`);
        console.log(`   Tier: ${techResult.tier}`);
        console.log(`   Percentage: ${techResult.percentage}%`);
        console.log(`   Bonus: ₹${techResult.bonus.toFixed(2)}`);

        // 2. Performance Bonus on Self / Differential estimation (Capped at 22% for max slab)
        const selfPerformanceBonus = selfPV * 0.22;
        console.log(`\n2. Self Performance Bonus (22% slab): ₹${selfPerformanceBonus.toFixed(2)}`);

        // Gross Commission Estimate
        const grossCommission = techResult.bonus + selfPerformanceBonus;
        console.log(`\n3. Gross Commission Estimate: ₹${grossCommission.toFixed(2)}`);

        // TDS Deduction (2%)
        const tds = grossCommission * 0.02;
        const netPayable = grossCommission - tds;
        console.log(`4. TDS (2%): ₹${tds.toFixed(2)}`);
        console.log(`5. Net Payable Estimate: ₹${netPayable.toFixed(2)}`);

    } catch (error) {
        console.error("Real Test Error:", error);
    } finally {
        await sequelize.close();
        console.log("Database Connection Closed.");
    }
}

runRealTest();
