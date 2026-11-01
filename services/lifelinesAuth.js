/**
 * @file lifelinesAuth.js
 * @description Authentication, token issuance, rate limiting, and middleware for Lifelines API.
 */

'use strict';

const crypto = require('crypto');

// In-memory token store: token -> { buyerId, createdAt }
const activeTokens = new Map();

// In-memory rate limiter store: key -> { count, resetTime }
const rateLimitStore = new Map();

/**
 * Issue a secure token for an authenticated RCM buyer root.
 * @param {number|string} buyerId 
 * @returns {string} token
 */
function issueToken(buyerId) {
  const token = crypto.randomBytes(32).toString('hex');
  activeTokens.set(token, {
    buyerId: Number(buyerId),
    createdAt: Date.now()
  });
  return token;
}

/**
 * Revoke an active lifelines token.
 * @param {string} token 
 */
function revokeToken(token) {
  if (token) {
    activeTokens.delete(token);
  }
}

/**
 * Express middleware to authenticate requests using x-lifelines-token or Authorization Bearer.
 */
function requireLifelinesAuth(req, res, next) {
  const token = req.headers['x-lifelines-token'] || 
                req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
                req.query?.lifelinesToken;

  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized. Please re-authenticate with your RCM password via /sync.'
    });
  }

  const sessionData = activeTokens.get(token);
  req.lifelinesToken = token;
  req.lifelinesRoot = sessionData.buyerId;
  next();
}

/**
 * Simple in-memory sliding window rate limiter check.
 * @param {string} key 
 * @param {number} maxAttempts 
 * @param {number} windowMs 
 * @returns {boolean} allowed
 */
function allowAttempt(key, maxAttempts = 10, windowMs = 60 * 1000) {
  const now = Date.now();
  let record = rateLimitStore.get(key);

  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + windowMs };
    rateLimitStore.set(key, record);
    return true;
  }

  if (record.count >= maxAttempts) {
    return false;
  }

  record.count += 1;
  return true;
}

/**
 * Clear rate limit attempts on successful login/action.
 * @param {string} key 
 */
function clearAttempts(key) {
  rateLimitStore.delete(key);
}

module.exports = {
  issueToken,
  revokeToken,
  requireLifelinesAuth,
  allowAttempt,
  clearAttempts
};
