// src/config/redis.js
require('dotenv').config(); // 👈 Ye sabse important line hai (Variables load karne ke liye)
const IORedis = require('ioredis');

// URL Debugging (Logs mein dikhega ki URL mila ya nahi)
const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    console.error("❌ CRITICAL ERROR: REDIS_URL environment variable is MISSING!");
    console.log("⚠️ Falling back to 127.0.0.1 (Localhost) - This will FAIL on Cloud.");
} else {
    console.log("✅ Cloud Redis URL Detected:", redisUrl.substring(0, 20) + "..."); 
}

// Universal Connection Config
const connection = new IORedis(redisUrl || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null, // BullMQ Requirement
    enableReadyCheck: false,
    // Agar 'rediss://' (Secure) hai to TLS enable karo
    tls: redisUrl && redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
});

connection.on('connect', () => console.log('🔌 Redis: Connecting...'));
connection.on('ready', () => console.log('⚡ Redis: Connected & Ready!'));
connection.on('error', (err) => console.error('🔥 Redis Error:', err.message));

module.exports = connection;