/**
 * @file src/config/redis.js
 * @description Titan Centralized Redis Core (Fixed for Startup Crash)
 */
require('dotenv').config();
const IORedis = require('ioredis');

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    console.log("⚠️ [TITAN-REDIS] Using Localhost (Dev Mode)");
} else {
    console.log("✅ [TITAN-REDIS] Cloud URL Detected");
}

const connection = new IORedis(redisUrl || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    
    // ✅ CRITICAL FIX: Ise 'true' karein taaki startup par crash na ho
    enableOfflineQueue: true, 

    tls: redisUrl && redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

connection.on('connect', () => console.log('🔌 [TITAN-REDIS] Connecting...'));
connection.on('ready', () => console.log('⚡ [TITAN-REDIS] Ready!'));
connection.on('error', (err) => console.warn('⚠️ [TITAN-REDIS] Status:', err.message));

// Smart Caching Functions
const getSmartCache = async (key) => {
    try {
        const data = await connection.get(key);
        return data ? JSON.parse(data) : null;
    } catch (e) { return null; }
};

const setSmartCache = async (key, value, ttl = 3600) => {
    try {
        await connection.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (e) {}
};

module.exports = { connection, getSmartCache, setSmartCache };