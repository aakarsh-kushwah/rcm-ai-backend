/**
 * @file rcm-ai-backend/services/businessCalculator.js
 * @description Deterministic calculator engine for RCM business bonuses and pin levels.
 * @module services/businessCalculator
 */

const db = require("../models");
const { BusinessKnowledge } = db;

/**
 * Helper function to determine Royalty tier and rate.
 * @param {number} legA_PV
 * @param {number} legB_PV
 * @returns {{name: string, rate: number, percentage: number}}
 */
function getRoyaltyTier(legA_PV, legB_PV) {
    const higherLeg = Math.max(legA_PV, legB_PV);
    const lowerLeg = Math.min(legA_PV, legB_PV);

    const tiers = [
        { name: "Star Platinum", minLegAPv: 350000, minLegBPv: 350000, percentage: 8, rate: 0.08 },
        { name: "Platinum", minLegAPv: 350000, minLegBPv: 260000, percentage: 6, rate: 0.06 },
        { name: "Star Gold", minLegAPv: 350000, minLegBPv: 170000, percentage: 4.5, rate: 0.045 },
        { name: "Gold", minLegAPv: 350000, minLegBPv: 115000, percentage: 3, rate: 0.03 }
    ];

    for (const tier of tiers) {
        if (higherLeg >= tier.minLegAPv && lowerLeg >= tier.minLegBPv) {
            return tier;
        }
    }
    return { name: "No Royalty Tier Matched", rate: 0, percentage: 0 };
}

/**
 * Helper function to get Performance Bonus percentage rate (decimal) based on PV.
 * @param {number} pv
 * @returns {number} rate as decimal (e.g. 0.22 for 22%)
 */
function getPerformanceBonusPercent(pv) {
    const slabs = [
        { min: 350000, max: Infinity, percentage: 22 },
        { min: 260000, max: 349999, percentage: 19.5 },
        { min: 170000, max: 259999, percentage: 17 },
        { min: 115000, max: 169999, percentage: 14.5 },
        { min: 70000, max: 114999, percentage: 12 },
        { min: 40000, max: 69999, percentage: 9.5 },
        { min: 20000, max: 39999, percentage: 7 },
        { min: 10000, max: 19999, percentage: 4.5 },
        { min: 5000, max: 9999, percentage: 2 },
        { min: 100, max: 4999, percentage: 0 }
    ];

    let percentage = 0;
    for (const slab of slabs) {
        if (pv >= slab.min && pv <= slab.max) {
            percentage = slab.percentage;
            break;
        }
    }
    return percentage / 100;
}

/**
 * Calculates the Performance Bonus based on PV.
 * Data is fetched from the BusinessKnowledge table.
 * @param {number} pv - Personal Volume (PV) of the distributor.
 * @returns {number} The calculated Performance Bonus in ₹.
 */
async function calculatePerformanceBonus(pv) {
    try {
        const rate = getPerformanceBonusPercent(pv);
        const bonus = pv * rate;
        return bonus;
    } catch (error) {
        console.error("Error calculating performance bonus:", error);
        throw new Error("Failed to calculate performance bonus.");
    }
}

/**
 * Calculates the Royalty Bonus based on leg PVs using the refined rule:
 * - If second leg < 350,000 PV (not independently main-leg qualified): simple formula (higherLeg * royaltyRate).
 * - If second leg >= 350,000 PV (both legs independently >= 350,000): differential formula.
 * @param {number} legA_PV - PV of the first leg.
 * @param {number} legB_PV - PV of the second leg.
 * @returns {Promise<{tier: string, percentage: number, mainLegBonus: number, secondLegBonus: number, bonus: number}>} The calculated Royalty Bonus details.
 */
async function calculateRoyaltyBonus(legA_PV, legB_PV) {
    try {
        const total = legA_PV + legB_PV;
        const higherLeg = Math.max(legA_PV, legB_PV);
        const lowerLeg = Math.min(legA_PV, legB_PV);
        
        // Step 1: Determine Royalty tier based on legA (main) and legB (second)
        const royaltyTier = getRoyaltyTier(legA_PV, legB_PV); // e.g. {name: "Gold", rate: 0.03}
        
        if (royaltyTier.rate === 0) {
            return { tier: "No Royalty Tier Matched", percentage: 0, mainLegBonus: 0, secondLegBonus: 0, bonus: 0 };
        }

        let mainLegBonus;
        let secondLegBonus;
        let totalBonus;

        // Rule: If lower leg < 350,000 PV, use simple formula (higherLeg * rate)
        if (lowerLeg < 350000) {
            mainLegBonus = higherLeg * royaltyTier.rate;
            secondLegBonus = 0; // No differential bonus from second leg in this scenario
            totalBonus = mainLegBonus;
        } else {
            // Both legs >= 350,000 PV. Use the full differential formula.
            mainLegBonus = higherLeg * royaltyTier.rate;
            const ownOverallPercent = getPerformanceBonusPercent(total);
            const secondLegOwnPercent = getPerformanceBonusPercent(lowerLeg);
            const differentialPercent = Math.max(0, ownOverallPercent - secondLegOwnPercent);
            secondLegBonus = lowerLeg * differentialPercent;
            totalBonus = mainLegBonus + secondLegBonus;
        }
        
        let disclaimer = "";
        if (royaltyTier.name === "Star Platinum" && lowerLeg >= 350000) {
            disclaimer = "Aap dono legs se independently Royalty-qualify kar rahe hain - yeh ek advanced scenario hai jiska exact calculation abhi confirm nahi hua hai. Approximate estimate: ₹[AMOUNT], lekin exact amount ke liye apna Monthly Statement check karein.";
        }
        
        return { 
            royaltyBonus: totalBonus, // Changed 'bonus' to 'royaltyBonus' for clarity
            tier: royaltyTier.name, 
            percentage: royaltyTier.percentage, 
            mainLegBonus, 
            secondLegBonus, 
            disclaimer 
        };
    } catch (error) {
        console.error("Error calculating royalty bonus:", error);
        throw new Error("Failed to calculate royalty bonus.");
    }
}

/**
 * Calculates the Technical Bonus based on leg PVs.
 * @param {number} legA_PV - PV of the first leg.
 * @param {number} legB_PV - PV of the second leg.
 * @returns {{tier: string, percentage: number, bonus: number}} The calculated Technical Bonus details.
 */
async function calculateTechnicalBonus(legA_PV, legB_PV) {
    try {
        const higherLeg = Math.max(legA_PV, legB_PV);
        const lowerLeg = Math.min(legA_PV, legB_PV);

        // Tiers from Marketing Plan V3:
        // - Pearl (1%): A: 5L | B: 5L
        // - Star Pearl (1.75%): A: 10L | B: 10L
        // - Emerald (2.5%): A: 22L | B: 22L
        // - Star Emerald (3%): A: 48L | B: 48L
        // - Ruby (3.50%): A: 100L | B: 100L
        // - Star Ruby (4%): A: 200L | B: 200L
        // - Sapphire (4.50%): A: 500L | B: 500L
        // - Star Sapphire (4.75%): A: 1000L | B: 1000L
        // - Diamond (5%): A: 2500L | B: 2500L
        const tiers = [
            { name: "Diamond", minLegAPv: 250000000, minLegBPv: 250000000, percentage: 5 },
            { name: "Star Sapphire", minLegAPv: 100000000, minLegBPv: 100000000, percentage: 4.75 },
            { name: "Sapphire", minLegAPv: 50000000, minLegBPv: 50000000, percentage: 4.5 },
            { name: "Star Ruby", minLegAPv: 20000000, minLegBPv: 20000000, percentage: 4 },
            { name: "Ruby", minLegAPv: 10000000, minLegBPv: 10000000, percentage: 3.5 },
            { name: "Star Emerald", minLegAPv: 4800000, minLegBPv: 4800000, percentage: 3 },
            { name: "Emerald", minLegAPv: 2200000, minLegBPv: 2200000, percentage: 2.5 },
            { name: "Star Pearl", minLegAPv: 1000000, minLegBPv: 1000000, percentage: 1.75 },
            { name: "Pearl", minLegAPv: 500000, minLegBPv: 500000, percentage: 1 }
        ];

        let matchedTier = null;
        for (const tier of tiers) {
            if (higherLeg >= tier.minLegAPv && lowerLeg >= tier.minLegBPv) {
                matchedTier = tier;
                break;
            }
        }

        if (matchedTier) {
            const bonus = (legA_PV + legB_PV) * (matchedTier.percentage / 100);
            return { tier: matchedTier.name, percentage: matchedTier.percentage, bonus: bonus };
        } else {
            return { tier: "No Technical Tier Matched", percentage: 0, bonus: 0 };
        }
    } catch (error) {
        console.error("Error calculating technical bonus:", error);
        throw new Error("Failed to calculate technical bonus.");
    }
}

/**
 * Determines the Pin Level based on leg PVs.
 * Data is fetched from the BusinessKnowledge table.
 * @param {number} legA_PV - PV of the first leg.
 * @param {number} legB_PV - PV of the second leg.
 * @returns {{level: string, incomeRange: string}} The matched Pin Level and its associated income range.
 */
async function getPinLevel(legA_PV, legB_PV) {
    try {
        const knowledge = await BusinessKnowledge.findOne({
            where: { category: "Vital_Level_Pin_Chart" }
        });

        if (!knowledge) {
            console.warn("Vital Level Pin Chart knowledge not found.");
            return { level: "Associate" };
        }

        const higherLeg = Math.max(legA_PV, legB_PV);
        const lowerLeg = Math.min(legA_PV, legB_PV);
        const totalPv = legA_PV + legB_PV;

        // Check Vital Levels:
        // - Star | Total PV: 3,50,000+ | Min Other Group PV: 70,000+
        // - Winner | Total PV: 2,60,000+ | Min Other Group PV: 50,000+
        // - Runner | Total PV: 1,70,000+ | Min Other Group PV: 40,000+
        // - Eagle | Total PV: 1,15,000+ | Min Other Group PV: 30,000+
        // - Opener | Total PV: 70,000+ | Min Other Group PV: 20,000+
        const pins = [
            { level: "Star", minTotalPv: 350000, minOtherPv: 70000 },
            { level: "Winner", minTotalPv: 260000, minOtherPv: 50000 },
            { level: "Runner", minTotalPv: 170000, minOtherPv: 40000 },
            { level: "Eagle", minTotalPv: 115000, minOtherPv: 30000 },
            { level: "Opener", minTotalPv: 70000, minOtherPv: 20000 }
        ];

        let matchedPin = null;
        for (const pin of pins) {
            if (totalPv >= pin.minTotalPv && lowerLeg >= pin.minOtherPv) {
                matchedPin = pin;
                break;
            }
        }

        if (matchedPin) {
            return { level: matchedPin.level };
        } else {
            // Check lower slabs based on total PV
            if (totalPv >= 10000) return { level: "Starter / Beginner" };
            return { level: "Associate" };
        }
    } catch (error) {
        console.error("Error getting pin level:", error);
        throw new Error("Failed to get pin level.");
    }
}

const TDS_PERCENTAGE = 2; // As per RCM business plan

module.exports = {
    calculatePerformanceBonus,
    calculateRoyaltyBonus,
    calculateTechnicalBonus,
    getPinLevel,
    TDS_PERCENTAGE,
};
