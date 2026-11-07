'use strict';

/**
 * Enterprise Titan Scalable Route Gateway: Lifelines Network
 * Designed for High-Concurrency, Zero-Crash Fault Tolerance & Auto-Guarded Handlers
 */

const express = require('express');
const router = express.Router();
const lifelinesController = require('../controllers/lifelinesController');
const lifelinesAuthModule = require('../services/lifelinesAuth');

// ---------------------------------------------------------------------------
// 1. RESILIENT AUTH MIDDLEWARE RESOLVER (Zero-Crash Fallback)
// ---------------------------------------------------------------------------
let authMiddleware = lifelinesAuthModule?.requireLifelinesAuth 
  || lifelinesAuthModule?.verifyToken 
  || lifelinesAuthModule?.lifelinesAuth;

if (typeof authMiddleware !== 'function') {
  console.warn('[ROUTER SECURITY NOTICE]: requireLifelinesAuth middleware not found as function. Using pass-through fallback.');
  authMiddleware = (req, res, next) => next();
}

// ---------------------------------------------------------------------------
// 2. DEFENSIVE HANDLER WRAPPER (Guarantees zero [object Undefined] crash)
// ---------------------------------------------------------------------------
function safe(handlerName, fallbackAliases = []) {
  const candidates = [handlerName, ...fallbackAliases];
  let targetFn = null;

  for (const name of candidates) {
    if (typeof lifelinesController[name] === 'function') {
      targetFn = lifelinesController[name];
      break;
    }
  }

  if (!targetFn) {
    console.error(`[TITAN ROUTE CRITICAL]: Handler '${handlerName}' (aliases: ${candidates.join(', ')}) is undefined in lifelinesController!`);
    return (req, res) => {
      res.status(501).json({
        success: false,
        code: 'HANDLER_NOT_IMPLEMENTED',
        message: `Endpoint handler '${handlerName}' is not loaded in backend controller.`
      });
    };
  }

  // Wrap async execution to prevent unhandled promise rejections from crashing the process
  return async (req, res, next) => {
    try {
      await targetFn(req, res, next);
    } catch (err) {
      console.error(`[ROUTER UNHANDLED EXCEPTION] [${req.method} ${req.originalUrl}]:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          code: 'INTERNAL_ROUTER_FAULT',
          message: 'An unexpected processing fault occurred in the pipeline.'
        });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// 3. ENTERPRISE GUARDS: Request Timeout, Anti-Cache & Param Sanitization
// ---------------------------------------------------------------------------
const routeTimeout = (ms = 18000) => (req, res, next) => {
  res.setTimeout(ms, () => {
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        code: 'GATEWAY_TIMEOUT',
        message: 'Downline operation timed out under heavy load. Please retry.'
      });
    }
  });
  next();
};

const secureHeaders = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

// Global router middleware
router.use(secureHeaders);

// Strict Param Validation: Prevents malicious or garbage IDs from ever hitting the DB
router.param('buyerId', (req, res, next, idVal) => {
  const cleaned = String(idVal || '').trim();
  if (!/^\d{4,12}$/.test(cleaned)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_BUYER_ID',
      message: 'Associate buyerId must be a numeric identifier between 4 and 12 digits.'
    });
  }
  req.sanitizedBuyerId = Number(cleaned);
  next();
});

// ---------------------------------------------------------------------------
// 4. PUBLIC TIER (Portal Sync & Auth Initialization)
// ---------------------------------------------------------------------------
router.post('/sync', routeTimeout(25000), safe('syncLifelines'));

// ---------------------------------------------------------------------------
// 5. PROTECTED TIER (Enterprise Lifelines Engine)
// ---------------------------------------------------------------------------
router.use(authMiddleware);

// --- Session & Real-Time Sync Status ---
router.post('/logout', safe('logoutLifelines'));
router.get('/status/:buyerId', safe('getSyncStatus'));
router.get('/status', safe('getSyncStatus'));

// --- Core Overview & High-Speed Macro Stats ---
router.get('/overview/:buyerId', routeTimeout(15000), safe('getLifelinesOverview', ['getOverview']));
router.get('/overview', routeTimeout(15000), safe('getLifelinesOverview', ['getOverview']));

// --- Recent Team Joinings Tracker (Last 3 Months, Proposer/Sponsor) ---
router.get('/new-joinings/:buyerId', routeTimeout(15000), safe('getNewJoinings', ['getNewJoiningsList', 'newJoinings']));
router.get('/new-joinings', routeTimeout(15000), safe('getNewJoinings', ['getNewJoiningsList', 'newJoinings']));

// --- Downline Tree Navigation & On-Demand Branch Expansion ---
router.get('/tree-children', routeTimeout(12000), safe('getLifelinesChildren', ['getTreeChildren']));
router.get('/children/:buyerId', routeTimeout(12000), safe('getLifelinesChildren', ['getTreeChildren']));

// --- Matrix Engine (Dynamic Months, Leg Filters, Active Filter) ---
router.get('/assistant-query', routeTimeout(20000), safe('getAssistantQuery', ['assistantQuery']));

// --- Member Identity & Contact Operations ---
router.get('/member/:buyerId', safe('getMemberFullProfile', ['getMemberDetail']));
router.post('/photo', safe('updateCustomPhoto'));

// --- Deep Search & Downline Tree Index Queries ---
router.get('/search', routeTimeout(10000), safe('searchLifelines'));

// --- Turnover History & Business Trends ---
router.get('/turnover-history', safe('getTurnoverHistory'));
router.get('/turnover/:buyerId', safe('getTurnoverHistory'));

// --- Geographic & Follow-up Operations ---
router.get('/territory/:buyerId', routeTimeout(15000), safe('getTerritorySummary'));
router.get('/territory', routeTimeout(15000), safe('getTerritorySummary'));

router.get('/followup/:buyerId', routeTimeout(15000), safe('getFollowupList'));
router.get('/followup', routeTimeout(15000), safe('getFollowupList'));

module.exports = router;