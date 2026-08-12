/**
 * @file rcm-ai-backend/controllers/calculatorController.js
 * @description Controller for consolidated RCM bonus calculations.
 * @module controllers/calculatorController
 */

const asyncHandler = require("express-async-handler");
const db = require("../models");
const {
    calculatePerformanceBonus,
    calculateRoyaltyBonus,
    calculateTechnicalBonus,
    getPinLevel,
    TDS_PERCENTAGE
} = require("../services/businessCalculator");

/**
 * @function calculateAllBonuses
 * @description Calculates Performance, Royalty, and Technical Bonuses, and determines Pin Level.
 * @param {object} req - Express request object.
 * @param {number} req.body.selfPurchasePv - Self Purchase PV.
 * @param {number} req.body.legAPv - PV for Leg A.
 * @param {number} req.body.legBPv - PV for Leg B.
 * @param {object} res - Express response object.
 */
const calculateAllBonuses = asyncHandler(async (req, res) => {
    let { selfPurchasePv, legAPv, legBPv } = req.body;

    // Ensure PV values are numbers, default to 0 if not provided or invalid
    selfPurchasePv = Number(selfPurchasePv) || 0;
    legAPv = Number(legAPv) || 0;
    legBPv = Number(legBPv) || 0;

    if (isNaN(selfPurchasePv) || isNaN(legAPv) || isNaN(legBPv)) {
        return res.status(400).json({ success: false, message: "Invalid PV values provided." });
    }

    let performanceBonus = 0;
    let royaltyBonus = 0;
    let technicalBonus = 0;
    let pinLevel = "Associate";
    let royaltyDisclaimer = "";

    try {
        // Calculate Performance Bonus (uses selfPurchasePv or leg PVs combined based on business logic)
        // Assuming performance bonus might consider self PV directly or total group PV
        // For simplicity, let's use selfPurchasePv for performance bonus calculation as per common models
        performanceBonus = await calculatePerformanceBonus(selfPurchasePv);

        // Calculate Royalty Bonus
        const royaltyResult = await calculateRoyaltyBonus(legAPv, legBPv);
        royaltyBonus = royaltyResult.royaltyBonus;
        royaltyDisclaimer = royaltyResult.disclaimer.replace("[AMOUNT]", parseFloat(royaltyBonus.toFixed(2))) || "";

        // Calculate Technical Bonus
        technicalBonus = await calculateTechnicalBonus(legAPv, legBPv);

        // Determine Pin Level
        pinLevel = await getPinLevel(legAPv, legBPv);

        // Calculate Gross Income
        const grossIncome = performanceBonus + royaltyBonus + technicalBonus;

        // Calculate TDS (2% as per requirement)
        const tdsAmount = grossIncome * (TDS_PERCENTAGE / 100); // TDS_PERCENTAGE should be defined in businessCalculator

        // Calculate Net Payable
        const netPayable = grossIncome - tdsAmount;

        res.status(200).json({
            success: true,
            data: {
                performanceBonus: parseFloat(performanceBonus.toFixed(2)),
                royaltyBonus: parseFloat(royaltyBonus.toFixed(2)),
                technicalBonus: parseFloat(technicalBonus.toFixed(2)),
                grossIncome: parseFloat(grossIncome.toFixed(2)),
                tdsPercentage: TDS_PERCENTAGE,
                tdsAmount: parseFloat(tdsAmount.toFixed(2)),
                netPayable: parseFloat(netPayable.toFixed(2)),
                pinLevel,
                royaltyDisclaimer
            }
        });

        setImmediate(async () => {
            try {
                const reqUserId = req.body.userId || req.user?.id;
                if (reqUserId) {
                    await db.ChatMessage.create({
                        userId: reqUserId,
                        sender: "SYSTEM",
                        message: `Calculator Used (Self PV: ${selfPurchasePv}, Leg A PV: ${legAPv}, Leg B PV: ${legBPv})`,
                        response: JSON.stringify({
                            type: "calculator_widget",
                            data: {
                                selfPurchasePv,
                                legAPv,
                                legBPv,
                                performanceBonus: parseFloat(performanceBonus.toFixed(2)),
                                royaltyBonus: parseFloat(royaltyBonus.toFixed(2)),
                                technicalBonus: parseFloat(technicalBonus.toFixed(2)),
                                grossIncome: parseFloat(grossIncome.toFixed(2)),
                                netPayable: parseFloat(netPayable.toFixed(2)),
                                pinLevel
                            }
                        }),
                        source: "BUSINESS_CALCULATOR_RESULT"
                    });
                }
            } catch (err) {
                console.error("Calculator Log Error:", err.message);
            }
        });
    } catch (error) {
        console.error("Error in calculateAllBonuses:", error.message);
        res.status(500).json({ success: false, message: "Failed to calculate bonuses. Please try again." });
    }
});

module.exports = {
    calculateAllBonuses
};