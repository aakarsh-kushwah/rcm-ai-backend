'use strict';

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { connection: redisClient } = require('../config/redis');

const DEFAULT_BASE_URL = 'https://www.rcmworld.com';
const LOGIN_API_URL = 'https://ecomapi.rcmworld.com/api/generic/users/login-user';
const ECOM_BASE = 'https://ecomapi.rcmworld.com/api';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SESSION_TTL_SEC = 24 * 60 * 60; // 24 hours

const sessionCache = new Map();

class RcmAuthError extends Error {
  constructor(message = 'RCM authentication failed.') {
    super(message);
    this.name = 'RcmAuthError';
  }
}

class RcmUnavailableError extends Error {
  constructor(message = 'RCM is temporarily unavailable.') {
    super(message);
    this.name = 'RcmUnavailableError';
  }
}

class RcmParseError extends Error {
  constructor(message = 'Unable to parse the RCM response.') {
    super(message);
    this.name = 'RcmParseError';
  }
}

function redisKey(buyerId) {
  return `rcm:session:${String(buyerId).trim()}`;
}

function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return baseUrl;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  return new URL(rawUrl, baseUrl).toString();
}

function cleanTokenValue(rawToken) {
  if (!rawToken) return '';
  let token = String(rawToken).trim();
  if (token.includes('%')) {
    try {
      token = decodeURIComponent(token);
    } catch {
      // ignore
    }
  }
  return token;
}

function extractTokenDeep(data) {
  if (!data) return { token: '', refreshToken: '', associateName: '' };

  let payload = data;
  if (typeof data === 'string') {
    try {
      payload = JSON.parse(data);
    } catch {
      payload = data;
    }
  }

  if (typeof payload === 'string') {
    const t = cleanTokenValue(payload);
    return { token: t, refreshToken: t, associateName: '' };
  }

  if (typeof payload?.data === 'string' && payload.data.length > 20) {
    const t = cleanTokenValue(payload.data);
    return {
      token: t,
      refreshToken: cleanTokenValue(payload.refreshToken) || t,
      associateName: payload.name || payload.userName || ''
    };
  }

  let foundToken = '';
  let foundRefreshToken = '';
  let foundName = '';

  function search(obj, depth = 0) {
    if (!obj || depth > 5 || foundToken) return;

    if (typeof obj === 'string') {
      if (obj.startsWith('U2FsdGVkX1') || (obj.startsWith('ey') && obj.includes('.'))) {
        foundToken = cleanTokenValue(obj);
      }
      return;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) search(item, depth + 1);
      return;
    }

    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const lk = k.toLowerCase();
        const v = obj[k];

        if (typeof v === 'string' && v.length > 20) {
          if (lk.includes('token') || lk.includes('jwt') || lk.includes('auth')) {
            if (lk.includes('refresh')) {
              foundRefreshToken = cleanTokenValue(v);
            } else if (!foundToken) {
              foundToken = cleanTokenValue(v);
            }
          }
        }

        if (typeof v === 'string' && (lk.includes('name') || lk === 'user_name') && !foundName) {
          foundName = v;
        }
      }

      if (!foundToken) {
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'object' || typeof obj[k] === 'string') {
            search(obj[k], depth + 1);
          }
        }
      }
    }
  }

  search(payload);

  return {
    token: foundToken,
    refreshToken: foundRefreshToken || foundToken,
    associateName: foundName,
    raw: payload
  };
}

function buildSessionObject({ buyerId, token = '', refreshToken = '', baseUrl = DEFAULT_BASE_URL, userAgent = DEFAULT_UA }) {
  const safeBuyerId = String(buyerId).trim();
  const cleanBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const jar = new CookieJar();
  let currentToken = cleanTokenValue(token);
  let currentRefreshToken = cleanTokenValue(refreshToken) || currentToken;
  let sessionPassword = null;

  const client = wrapper(
    axios.create({
      baseURL: cleanBase,
      jar,
      withCredentials: true,
      timeout: 25000,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
        'User-Agent': userAgent || DEFAULT_UA,
        Origin: cleanBase,
        Referer: `${cleanBase}/`
      },
      maxRedirects: 5,
      validateStatus: () => true
    })
  );

  const applyTokenHeadersAndCookies = async (tok) => {
    const cleaned = cleanTokenValue(tok);
    if (!cleaned) return;
    currentToken = cleaned;
    client.defaults.headers.common['Authorization'] = `Bearer ${cleaned}`;

    const menuPerms = '["my_account","personal_info","your_purchase_volume","your_group","identity_card","monthly_statement"]';
    const encodedToken = encodeURIComponent(cleaned);

    await jar.setCookie(`ecomToken=${encodedToken}; Domain=.rcmworld.com; Path=/`, cleanBase).catch(() => null);
    await jar.setCookie(`ecomToken=${encodedToken}; Domain=www.rcmworld.com; Path=/`, cleanBase).catch(() => null);
    await jar.setCookie(`ecomRefreshToken=${encodedToken}; Domain=.rcmworld.com; Path=/`, cleanBase).catch(() => null);
    await jar.setCookie(`user_code=${safeBuyerId}; Domain=.rcmworld.com; Path=/`, cleanBase).catch(() => null);
    await jar.setCookie(`menu_permission=${encodeURIComponent(menuPerms)}; Domain=.rcmworld.com; Path=/`, cleanBase).catch(() => null);
  };

  if (currentToken) {
    client.defaults.headers.common['Authorization'] = `Bearer ${currentToken}`;
  }

  const syncCookiesToAxios = async () => {
    try {
      const cookieHeaderStr = await jar.getCookieString(cleanBase);
      if (cookieHeaderStr) {
        client.defaults.headers.common['Cookie'] = cookieHeaderStr;
      }
    } catch (err) {
      console.warn('[COOKIE SYNC WARN]:', err.message);
    }
  };

  const isAuthenticated = async () => {
    try {
      const month = new Date().getMonth() + 1;
      const year = new Date().getFullYear();
      const testUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume/profile?distno=${safeBuyerId}&month=${month}&year=${year}`;

      await syncCookiesToAxios();
      const res = await client.get(testUrl, {
        headers: {
          Origin: cleanBase,
          Referer: `${cleanBase}/`
        },
        timeout: 6000
      });

      return Boolean(res.status === 200 && res.data && res.data.success !== false);
    } catch {
      return false;
    }
  };

  const setPassword = (pw) => {
    sessionPassword = pw ? String(pw).trim() : null;
  };

  const login = async () => {
    if (!sessionPassword) {
      throw new RcmAuthError('Password is required to authenticate with RCM.');
    }

    const apiPayload = {
      user_code: safeBuyerId,
      user_password: sessionPassword,
      versioncode: '186',
      appversion: 'ANDROID-2.5.57',
      user_type: 'user_id'
    };

    let apiRes = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        apiRes = await client.post(LOGIN_API_URL, apiPayload, {
          headers: {
            'Content-Type': 'application/json',
            Origin: cleanBase,
            Referer: `${cleanBase}/`,
            'User-Agent': userAgent || DEFAULT_UA
          },
          timeout: 15000
        });
        break;
      } catch (err) {
        const isTransient = /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|timeout/i.test(err.message || '');
        if (attempt === 2 || !isTransient) {
          throw new RcmUnavailableError('RCM login gateway timed out or is temporarily unreachable.');
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    let { token, refreshToken: extractedRefresh, raw } = extractTokenDeep(apiRes?.data);

    if (!token) {
      try {
        const jarCookies = await jar.getCookies(cleanBase);
        for (const c of jarCookies) {
          if (/token|jwt/i.test(c.key) && c.value && c.value.length > 20) {
            token = cleanTokenValue(c.value);
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    if (token) {
      currentRefreshToken = cleanTokenValue(extractedRefresh) || token;
      await applyTokenHeadersAndCookies(token);
    }

    await syncCookiesToAxios();

    const isGatewaySuccess =
      apiRes?.status === 200 &&
      (apiRes.data?.login === true ||
        apiRes.data?.success === true ||
        /logged in successful/i.test(apiRes.data?.message || ''));

    if (isGatewaySuccess) {
      return true;
    }

    if (raw && (raw.login === false || raw.success === false)) {
      throw new RcmAuthError(raw.message || 'Invalid RCM Buyer ID or Password.');
    }

    if (await isAuthenticated()) {
      return true;
    }

    throw new RcmAuthError('Invalid RCM Buyer ID or Password.');
  };

  const get = async (url, config = {}) => {
    await syncCookiesToAxios();
    return client.get(normalizeUrl(url, cleanBase), config);
  };

  const post = async (url, data, config = {}) => {
    await syncCookiesToAxios();
    return client.post(normalizeUrl(url, cleanBase), data, config);
  };

  const close = () => {
    jar.removeAllCookiesSync();
    delete client.defaults.headers.common['Authorization'];
    delete client.defaults.headers.common['Cookie'];
    sessionPassword = null;
    clearSession(safeBuyerId);
  };

  const toSerializable = () => ({
    buyerId: safeBuyerId,
    token: currentToken,
    refreshToken: currentRefreshToken,
    baseUrl: cleanBase,
    savedAt: Date.now()
  });

  const sessionInstance = {
    login,
    setPassword,
    get,
    post,
    close,
    isAuthenticated,
    toSerializable,
    jar,
    client,
    buyerId: safeBuyerId,
    safeBuyerId,
    get token() {
      return currentToken;
    },
    saveSession: async () => saveSession(safeBuyerId, sessionInstance)
  };

  return sessionInstance;
}

async function saveSession(buyerIdOrSession, maybeSession) {
  try {
    let bId = '';
    let sess = null;

    if (maybeSession) {
      bId = String(buyerIdOrSession).trim();
      sess = maybeSession;
    } else if (buyerIdOrSession && typeof buyerIdOrSession === 'object') {
      sess = buyerIdOrSession;
      bId = String(sess.buyerId || sess.safeBuyerId || '').trim();
    }

    if (!bId || !sess) return false;

    sessionCache.set(bId, {
      session: sess,
      savedAt: Date.now()
    });

    if (redisClient && typeof redisClient.set === 'function' && redisClient.status === 'ready') {
      const serialized = typeof sess.toSerializable === 'function'
        ? sess.toSerializable()
        : { buyerId: bId, token: sess.token || '' };

      await redisClient.set(redisKey(bId), JSON.stringify(serialized), 'EX', SESSION_TTL_SEC).catch(() => null);
    }

    return true;
  } catch (err) {
    console.warn('[SESSION SAVE WARN]:', err.message);
    return false;
  }
}

async function getSession(buyerId) {
  const bId = String(buyerId || '').trim();
  if (!bId) return null;

  const cached = sessionCache.get(bId);
  if (cached && cached.session) {
    return cached.session;
  }

  try {
    if (redisClient && typeof redisClient.get === 'function' && redisClient.status === 'ready') {
      const raw = await redisClient.get(redisKey(bId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.token) {
          const rebuilt = buildSessionObject({
            buyerId: bId,
            token: parsed.token,
            refreshToken: parsed.refreshToken,
            baseUrl: parsed.baseUrl
          });
          sessionCache.set(bId, { session: rebuilt, savedAt: Date.now() });
          return rebuilt;
        }
      }
    }
  } catch (err) {
    console.warn('[SESSION REDIS READ WARN]:', err.message);
  }

  return null;
}

async function clearSession(buyerId) {
  const bId = String(buyerId || '').trim();
  if (bId) {
    sessionCache.delete(bId);
    try {
      if (redisClient && typeof redisClient.del === 'function' && redisClient.status === 'ready') {
        await redisClient.del(redisKey(bId)).catch(() => null);
      }
    } catch {
      // ignore
    }
  } else {
    sessionCache.clear();
  }
}

function createRcmSession({ buyerId, password, options = {} } = {}) {
  if (!buyerId) throw new RcmAuthError('A buyer ID is required.');
  if (!password) throw new RcmAuthError('A password is required.');

  const sess = buildSessionObject({
    buyerId,
    baseUrl: options.baseUrl,
    userAgent: options.userAgent
  });
  sess.setPassword(password);
  return sess;
}

module.exports = {
  createRcmSession,
  saveSession,
  getSession,
  clearSession,
  RcmAuthError,
  RcmUnavailableError,
  RcmParseError
};
