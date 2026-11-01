'use strict';

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const DEFAULT_BASE_URL = 'https://www.rcmworld.com';
const LOGIN_API_URL = 'https://ecomapi.rcmworld.com/api/generic/users/login-user';
const ECOM_BASE = 'https://ecomapi.rcmworld.com/api';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return baseUrl;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  return new URL(rawUrl, baseUrl).toString();
}

function cleanTokenValue(rawToken) {
  if (!rawToken) return '';
  let token = String(rawToken).trim();
  // Decode if it has %2B or %2F
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

    if (bId) {
      sessionCache.set(bId, {
        session: sess,
        savedAt: new Date()
      });
      console.log(`[SESSION SAVED] Session persisted in cache for associate: ${bId}`);
    }
    return true;
  } catch (err) {
    console.warn('[SESSION SAVE WARN]:', err.message);
    return false;
  }
}

function getSession(buyerId) {
  const entry = sessionCache.get(String(buyerId).trim());
  return entry ? entry.session : null;
}

function clearSession(buyerId) {
  if (buyerId) {
    sessionCache.delete(String(buyerId).trim());
  } else {
    sessionCache.clear();
  }
}

function createRcmSession({ buyerId, password, options = {} } = {}) {
  if (!buyerId) throw new RcmAuthError('A buyer ID is required.');
  if (!password) throw new RcmAuthError('A password is required.');

  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const jar = new CookieJar();
  let sessionPassword = String(password).trim();
  const safeBuyerId = String(buyerId).trim();

  const client = wrapper(
    axios.create({
      baseURL: baseUrl,
      jar,
      withCredentials: true,
      timeout: Number(options.timeout || 25000),
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
        'User-Agent': options.userAgent || DEFAULT_UA,
        Origin: baseUrl,
        Referer: `${baseUrl}/`
      },
      maxRedirects: 5,
      validateStatus: () => true
    })
  );

  const syncCookiesToAxios = async () => {
    try {
      const cookieHeaderStr = await jar.getCookieString(baseUrl);
      if (cookieHeaderStr) {
        client.defaults.headers.common['Cookie'] = cookieHeaderStr;
      }
    } catch (err) {
      console.warn('[COOKIE SYNC WARN]:', err.message);
    }
  };

  /**
   * Fast REST API Verification (Bypasses slow 885 KB HTML scraping)
   */
  const isAuthenticated = async () => {
    try {
      const month = new Date().getMonth() + 1;
      const year = new Date().getFullYear();
      const testUrl = `${ECOM_BASE}/user/business-info/your-purchase-volume/profile?distno=${safeBuyerId}&month=${month}&year=${year}`;
      
      await syncCookiesToAxios();
      const res = await client.get(testUrl, {
        headers: {
          Origin: baseUrl,
          Referer: `${baseUrl}/`
        },
        timeout: 6000
      });

      if (res.status === 200 && res.data && res.data.success !== false) {
        console.log(`[RCM REST VERIFY] Direct REST API handshake verified 200 OK.`);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[RCM REST VERIFY NOTICE]:', err.message);
      return false;
    }
  };

  const login = async () => {
    console.log(`[RCM AUTH] Initiating login for Associate: ${safeBuyerId}`);

    try {
      const apiPayload = {
        user_code: safeBuyerId,
        user_password: sessionPassword,
        versioncode: '186',
        appversion: 'ANDROID-2.5.57',
        user_type: 'user_id'
      };

      const apiRes = await client.post(LOGIN_API_URL, apiPayload, {
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          Referer: `${baseUrl}/`,
          'User-Agent': options.userAgent || DEFAULT_UA
        },
        timeout: 15000
      });

      console.log(`[RCM AUTH API] Status: ${apiRes.status}`);
      console.log('[RCM AUTH API RAW DATA]:', JSON.stringify(apiRes.data));

      let { token, refreshToken, raw } = extractTokenDeep(apiRes.data);

      // Agar JSON body me direct token na ho, cookies me se clean token nikalein
      if (!token) {
        try {
          const jarCookies = await jar.getCookies(baseUrl);
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
        token = cleanTokenValue(token);
        console.log(`[RCM AUTH TOKEN CLEANED] Length: ${token.length}, Prefix: ${token.substring(0, 15)}...`);
        client.defaults.headers.common['Authorization'] = `Bearer ${token}`;

        const menuPerms = '["my_account","personal_info","your_purchase_volume","your_group","identity_card","monthly_statement"]';
        const encodedToken = encodeURIComponent(token);

        await jar.setCookie(`ecomToken=${encodedToken}; Domain=.rcmworld.com; Path=/`, baseUrl).catch(() => null);
        await jar.setCookie(`ecomToken=${encodedToken}; Domain=www.rcmworld.com; Path=/`, baseUrl).catch(() => null);
        await jar.setCookie(`ecomRefreshToken=${encodedToken}; Domain=.rcmworld.com; Path=/`, baseUrl).catch(() => null);
        await jar.setCookie(`user_code=${safeBuyerId}; Domain=.rcmworld.com; Path=/`, baseUrl).catch(() => null);
        await jar.setCookie(`menu_permission=${encodeURIComponent(menuPerms)}; Domain=.rcmworld.com; Path=/`, baseUrl).catch(() => null);
      }

      await syncCookiesToAxios();

      // Official Gateway Success Check
      const isGatewaySuccess = apiRes.status === 200 && (
        apiRes.data?.login === true || 
        apiRes.data?.success === true ||
        /logged in successful/i.test(apiRes.data?.message || '')
      );

      if (isGatewaySuccess) {
        console.log(`[RCM AUTH SUCCESS] Official Gateway accepted credentials for: ${safeBuyerId}`);
        // Fast test verification (non-blocking)
        await isAuthenticated();
        return true;
      }

      if (raw && (raw.login === false || raw.success === false)) {
        if (raw.message && /invalid|password|wrong|not matched/i.test(raw.message)) {
          throw new RcmAuthError(raw.message);
        }
      }
    } catch (apiErr) {
      if (apiErr instanceof RcmAuthError) throw apiErr;
      console.warn('[RCM AUTH API WARN] Gateway error:', apiErr.message);
    }

    // Secondary fallback
    if (await isAuthenticated()) {
      return true;
    }

    throw new RcmAuthError('Invalid RCM Buyer ID or Password.');
  };

  const get = async (url, config = {}) => {
    await syncCookiesToAxios();
    return client.get(normalizeUrl(url, baseUrl), config);
  };

  const post = async (url, data, config = {}) => {
    await syncCookiesToAxios();
    return client.post(normalizeUrl(url, baseUrl), data, config);
  };

  const close = () => {
    jar.removeAllCookiesSync();
    delete client.defaults.headers.common['Authorization'];
    delete client.defaults.headers.common['Cookie'];
    sessionPassword = null;
    clearSession(safeBuyerId);
  };

  const sessionInstance = {
    login,
    get,
    post,
    close,
    isAuthenticated,
    jar,
    client,
    buyerId: safeBuyerId,
    safeBuyerId,
    saveSession: async () => saveSession(safeBuyerId, sessionInstance)
  };

  return sessionInstance;
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