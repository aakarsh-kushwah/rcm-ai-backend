/**
 * @file src/config/redis.js
 * @description Titan Centralized Redis Core (Safe Offline/Cloud Fallback)
 */
require('dotenv').config();
const IORedis = require('ioredis');

const redisUrl = process.env.REDIS_URL || process.env.REDIS_CLOUD_URL || 'redis://127.0.0.1:6379';

if (!process.env.REDIS_URL && !process.env.REDIS_CLOUD_URL) {
    console.log("⚠️ [TITAN-REDIS] Using Localhost (Dev Mode)");
} else {
    console.log("✅ [TITAN-REDIS] Cloud URL Detected");
}

const redisClient = new IORedis(redisUrl, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    retryStrategy(times) {
        if (times > 3) {
            console.warn('⚠️ [TITAN-REDIS] Max reconnect attempts reached. Continuing in offline mode.');
            return null; // STOP infinite retrying
        }
        return Math.min(times * 200, 1000);
    }
});

let redisConnectionErrorLogged = false;

redisClient.on('error', (err) => {
    if (!redisConnectionErrorLogged) {
        console.warn('⚠️ [TITAN-REDIS] Connection error (running offline):', err.message);
        redisConnectionErrorLogged = true;
    }
});

redisClient.on('connect', () => {
    console.log('🔌 [TITAN-REDIS] Connected successfully.');
    redisConnectionErrorLogged = false; // Reset flag on successful connection
});

// Explicitly connect to trigger the connection process and error handling


// Graceful in-memory / fallback wrapper to ensure get/set/del never throw
const connection = redisClient;

const getSmartCache = async (key) => {
    try {
        if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
            return null;
        }
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        return null;
    }
};

const setSmartCache = async (key, value, ttl = 3600) => {
    try {
        if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
            return;
        }
        await redisClient.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (e) {
        // Ignore cache write errors when offline
    }
};

const delSmartCache = async (key) => {
    try {
        if (redisClient.status !== 'ready' && redisClient.status !== 'connecting') {
            return;
        }
        await redisClient.del(key);
    } catch (e) {
        // Ignore
    }
};

module.exports = { connection: redisClient, getSmartCache, setSmartCache, delSmartCache };
