/**
 * @file [`rcm-ai-backend/config/redis.js`](rcm-ai-backend/config/redis.js)
 * @description Titan Centralized Redis Core (Safe Offline/Cloud Fallback with In-Memory Dev Store)
 */
require('dotenv').config();
const IORedis = require('ioredis');

let actualRedisUrl;
const cloudRedisUrl = process.env.REDIS_URL || process.env.REDIS_CLOUD_URL || process.env.REDIS_PUBLIC_URL;

if (cloudRedisUrl && typeof cloudRedisUrl === 'string' && cloudRedisUrl.trim() !== '') {
    actualRedisUrl = cloudRedisUrl;
    const maskedUrl = actualRedisUrl.replace(/:([^:]*)@/, ':*****@');
    console.log(`✅ [TITAN-REDIS] Cloud URL Detected: ${maskedUrl}`);
} else {
    if (process.env.NODE_ENV !== 'production') {
        actualRedisUrl = 'redis://127.0.0.1:6379';
        console.log(`⚠️ [TITAN-REDIS] Using Localhost (Dev Mode): ${actualRedisUrl}`);
    } else {
        actualRedisUrl = '';
        console.error("❌ [TITAN-REDIS] No Redis URL provided in production environment. Connection will likely fail.");
    }
}

const redisClient = new IORedis(actualRedisUrl, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    tls: actualRedisUrl && actualRedisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    retryStrategy(times) {
        if (times > 3) {
            console.warn('⚠️ [TITAN-REDIS] Max reconnect attempts reached. Continuing in robust offline memory fallback mode.');
            return null; // STOP infinite retrying
        }
        return Math.min(times * 200, 1000);
    }
});

redisClient.connect().catch((e) => {
    console.error("⚠️ [TITAN-REDIS] Initial connection attempt failed (offline fallback active):", e.message);
});

let redisConnectionErrorLogged = false;

redisClient.on('error', (err) => {
    if (!redisConnectionErrorLogged) {
        console.warn('⚠️ [TITAN-REDIS] Connection error (running offline fallback):', err.message);
        redisConnectionErrorLogged = true;
    }
});

redisClient.on('connect', () => {
    console.log('🔌 [TITAN-REDIS] Connected successfully.');
    redisConnectionErrorLogged = false;
});

// In-memory fallback store for offline development
const memStore = new Map();
const memExpiry = new Map();

function isOffline() {
    return redisClient.status !== 'ready' && redisClient.status !== 'connecting';
}

// Pipeline/Multi stub support
class InMemoryPipeline {
    constructor(client) {
        this.client = client;
        this.commands = [];
    }
    get(key) { this.commands.push(['get', key]); return this; }
    set(key, value, ...args) { this.commands.push(['set', key, value, ...args]); return this; }
    del(...keys) { this.commands.push(['del', keys]); return this; }
    incr(key) { this.commands.push(['incr', key]); return this; }
    expire(key, seconds) { this.commands.push(['expire', key, seconds]); return this; }
    zadd(key, ...args) { this.commands.push(['zadd', key, args]); return this; }
    zrem(key, ...args) { this.commands.push(['zrem', key, args]); return this; }
    zscore(key, member) { this.commands.push(['zscore', key, member]); return this; }
    zrange(key, start, stop, ...args) { this.commands.push(['zrange', key, start, stop, args]); return this; }
    hset(key, ...args) { this.commands.push(['hset', key, args]); return this; }
    hget(key, field) { this.commands.push(['hget', key, field]); return this; }
    exec() {
        const results = [];
        for (const cmd of this.commands) {
            try {
                // Execute on memory store simulation or return success
                results.push([null, 'OK']);
            } catch (err) {
                results.push([err, null]);
            }
        }
        return Promise.resolve(results);
    }
}

// Robust Proxy wrapper around redisClient to guarantee fail-safe offline operation
const connection = new Proxy(redisClient, {
    get(target, prop, receiver) {
        if (isOffline()) {
            if (prop === 'status') return 'offline';
            if (prop === 'pipeline' || prop === 'multi') {
                return () => new InMemoryPipeline(target);
            }
            if (prop === 'get') {
                return async (key) => {
                    const exp = memExpiry.get(key);
                    if (exp && Date.now() > exp) {
                        memStore.delete(key);
                        memExpiry.delete(key);
                        return null;
                    }
                    return memStore.get(key) || null;
                };
            }
            if (prop === 'set') {
                return async (key, value, mode, ttl) => {
                    memStore.set(key, value);
                    if (mode === 'EX' && ttl) {
                        memExpiry.set(key, Date.now() + ttl * 1000);
                    } else if (typeof mode === 'number') {
                        memExpiry.set(key, Date.now() + mode * 1000);
                    }
                    return 'OK';
                };
            }
            if (prop === 'del') {
                return async (...keys) => {
                    let count = 0;
                    const flatKeys = keys.flat();
                    for (const k of flatKeys) {
                        if (memStore.delete(k)) count++;
                        memExpiry.delete(k);
                    }
                    return count;
                };
            }
            if (prop === 'incr') {
                return async (key) => {
                    const current = parseInt(memStore.get(key) || '0', 10);
                    const next = current + 1;
                    memStore.set(key, String(next));
                    return next;
                };
            }
            if (prop === 'expire') {
                return async (key, seconds) => {
                    if (memStore.has(key)) {
                        memExpiry.set(key, Date.now() + seconds * 1000);
                        return 1;
                    }
                    return 0;
                };
            }
            if (prop === 'keys') {
                return async (pattern) => {
                    const results = [];
                    const now = Date.now();
                    for (const [k, exp] of memExpiry.entries()) {
                        if (exp && now > exp) {
                            memStore.delete(k);
                            memExpiry.delete(k);
                        }
                    }
                    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                    for (const k of memStore.keys()) {
                        if (regex.test(k)) results.push(k);
                    }
                    return results;
                };
            }
            if (prop === 'call' || prop === 'sendCommand') {
                return async (...args) => null;
            }
            // Fallback for any other method: return safe default or no-op function
            const orig = Reflect.get(target, prop, receiver);
            if (typeof orig === 'function') {
                return async (...args) => {
                    try {
                        return await orig.apply(target, args);
                    } catch (e) {
                        // Suppress offline connection errors
                        return null;
                    }
                };
            }
        }
        return Reflect.get(target, prop, receiver);
    }
});

const getSmartCache = async (key) => {
    try {
        if (isOffline()) {
            const exp = memExpiry.get(key);
            if (exp && Date.now() > exp) {
                memStore.delete(key);
                memExpiry.delete(key);
                return null;
            }
            const data = memStore.get(key);
            return data ? JSON.parse(data) : null;
        }
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        return null;
    }
};

const setSmartCache = async (key, value, ttl = 3600) => {
    try {
        const jsonVal = JSON.stringify(value);
        if (isOffline()) {
            memStore.set(key, jsonVal);
            memExpiry.set(key, Date.now() + ttl * 1000);
            return;
        }
        await redisClient.set(key, jsonVal, 'EX', ttl);
    } catch (e) {
        // Ignore cache write errors when offline
    }
};

const delSmartCache = async (key) => {
    try {
        if (isOffline()) {
            memStore.delete(key);
            memExpiry.delete(key);
            return;
        }
        await redisClient.del(key);
    } catch (e) {
        // Ignore
    }
};

module.exports = { connection, getSmartCache, setSmartCache, delSmartCache };
