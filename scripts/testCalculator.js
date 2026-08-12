/**
 * @file rcm-ai-backend/scripts/testCalculator.js
 * @description Script to test Business Calculator functions.
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

async function runTests() {
    await connectDB();
    console.log("Database Connected for Calculator Tests.");

    try {
        console.log("\n--- Performance Bonus Test ---");
        const pb_result = await calculatePerformanceBonus(85000);
        console.log(`1. calculatePerformanceBonus(85000): ₹${pb_result.toFixed(2)}`);

        console.log("\n--- Royalty Bonus Tests ---");
        // Expected: 3% Gold tier
        const rb_result1 = await calculateRoyaltyBonus(350000, 115000);
        console.log(`2. calculateRoyaltyBonus(350000, 115000): Tier: ${rb_result1.tier}, %: ${rb_result1.percentage}, Bonus: ₹${rb_result1.bonus.toFixed(2)}`);
        
        // Expected: 8% Star Platinum
        const rb_result2 = await calculateRoyaltyBonus(350000, 350000);
        console.log(`3. calculateRoyaltyBonus(350000, 350000): Tier: ${rb_result2.tier}, %: ${rb_result2.percentage}, Bonus: ₹${rb_result2.bonus.toFixed(2)}`);

        console.log("\n--- Pin Level Test ---");
        const pin_result = await getPinLevel(350000, 70000);
        console.log(`4. getPinLevel(350000, 70000): Level: ${pin_result.level}, Income Range: ${pin_result.incomeRange}`);

    } catch (error) {
        console.error("Calculator Test Error:", error);
    } finally {
        await sequelize.close();
        console.log("Database Connection Closed.");
    }
}

runTests();
