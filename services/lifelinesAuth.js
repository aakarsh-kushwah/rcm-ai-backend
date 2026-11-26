'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const rateLimitStore = new Map();
const revokedTokens = new Set();

function getSigningSecret() {
  const secret = process.env.LIFELINES_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET or LIFELINES_TOKEN_SECRET must be set for stateless Lifelines auth.');
  }
  return secret;
}

function signPayload(encodedPayload) {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(encodedPayload)
    .digest('base64url');
}

function issueToken(buyerId) {
  const payload = {
    b: Number(buyerId),
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
    jti: crypto.randomBytes(8).toString('hex')
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = signPayload(encoded);
  return `${encoded}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || revokedTokens.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, sig] = parts;
  const expectedSig = signPayload(encoded);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.b || (payload.exp && Date.now() > payload.exp)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function revokeToken(token) {
  if (token) {
    revokedTokens.add(token);
  }
}

function requireLifelinesAuth(req, res, next) {
  const token =
    req.headers['x-lifelines-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query?.lifelinesToken;

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({
      success: false,
      message: 'Session expired. Please login again with your RCM Buyer ID and Password.'
    });
  }

  req.lifelinesToken = token;
  req.lifelinesRoot = Number(payload.b);
  next();
}

function allowAttempt(key, maxAttempts = 15, windowMs = 60 * 1000) {
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

function clearAttempts(key) {
  rateLimitStore.delete(key);
}

module.exports = {
  issueToken,
  verifyToken,
  revokeToken,
  requireLifelinesAuth,
  allowAttempt,
  clearAttempts
};
