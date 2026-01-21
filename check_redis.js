//        terminal cmd for check  data  node check_redis.js

// Hum koshish karenge ioredis use karne ki (kyunki Bull ioredis use karta hai)
// Agar error aaye to batana
try {
    const Redis = require('ioredis'); 
    const redis = new Redis({
  host: "127.0.0.1",
  port: 6379
}); // Default localhost:6379 connect karega

    async function run() {
        console.log("🔌 Connecting to Redis...");

        try {
            // 1. Error Fix Karo (RDB Snapshot Error)
            await redis.config('set', 'stop-writes-on-bgsave-error', 'no');
            console.log("✅ FIXED: Redis ab crash nahi karega (Config updated).");

            // 2. Data Count Check Karo
            const count = await redis.dbsize();
            console.log(`📊 Total Sawal/Jawab (Keys): ${count}`);

            // 3. Memory Check Karo
            const info = await redis.info('memory');
            const usedMemory = info.match(/used_memory_human:(.*)/);
            if (usedMemory) {
                console.log(`💾 Memory Used: ${usedMemory[1]}`);
            }

        } catch (err) {
            console.error("❌ Redis Error:", err.message);
        } finally {
            redis.disconnect();
            console.log("👋 Done.");
        }
    }

    run();

} catch (e) {
    console.log("❌ Error: 'ioredis' module nahi mila. Kya tumne npm install kiya hai?");
    console.log("Details:", e.message);
}