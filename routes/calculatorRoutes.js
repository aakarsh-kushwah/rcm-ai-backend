/**
 * @file rcm-ai-backend/routes/calculatorRoutes.js
 * @description API routes for RCM business calculations.
 * @module routes/calculatorRoutes
 */

const express = require("express");
const router = express.Router();
const asyncHandler = require("express-async-handler");
const { calculateAllBonuses } = require("../controllers/calculatorController");

/**
 * @route POST /api/calculator/bonus
 * @description Calculate all RCM bonuses (Performance, Royalty, Technical) and pin level.
 * @access Public (or protected if needed)
 * @param {object} req.body - Request body containing PV values.
 * @param {number} req.body.selfPurchasePv - Self Purchase PV.
 * @param {number} req.body.legAPv - PV for Leg A.
 * @param {number} req.body.legBPv - PV for Leg B.
 */
router.post("/bonus", calculateAllBonuses);

module.exports = router;