/**
 * @file workers/scheduler.js
 * @description Runs scheduled sync jobs OUTSIDE the web server.
 *   Run as its own process / Render "Background Worker": npm run worker:scheduler
 *   A Redis lock guarantees a run never overlaps, even if started twice by mistake.
 */

require("dotenv").config();

const crypto = require("crypto");
const cron = require("node-cron");

const { logger } = require("../utils/logger");
const { connectDB, sequelize, Channel } = require("../models");
const { connection: redisClient } = require("../config/redis");
const { syncChannel } = require("../services/channelSyncService");
const { syncAllAccounts: syncAllInstagramAccounts } = require("../services/instagramSyncService");

const LOCK_KEY = "lock:scheduler:incremental-sync";
const LOCK_TTL_SECONDS = 60 * 60 * 3; // 3 hours, shorter than the 4 hour interval
const INSTANCE_ID = crypto.randomUUID();

const acquireLock = async () => {
    const result = await redisClient.set(LOCK_KEY, INSTANCE_ID, "EX", LOCK_TTL_SECONDS, "NX");
    return result === "OK";
};

const releaseLock = async () => {
    // Delete only if we still own the lock
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    try {
        await redisClient.eval(script, 1, LOCK_KEY, INSTANCE_ID);
    } catch (err) {
        logger.warn({ err: err.message }, "[SCHEDULER] Could not release lock (it will expire on its own)");
    }
};

const runIncrementalSync = async () => {
    let locked = false;
    try {
        locked = await acquireLock();
    } catch (err) {
        logger.error({ err: err.message }, "[SCHEDULER] Redis lock failed, skipping this run");
        return;
    }

    if (!locked) {
        logger.warn("[SCHEDULER] Previous sync still running or another worker holds the lock. Skipping.");
        return;
    }

    logger.info("[CRON] Starting scheduled incremental sync for all active accounts.");
    try {
        // YouTube channels (sequential on purpose: protects API quota and DB pool)
        const channels = await Channel.findAll({ where: { isActive: true } });
        for (const channel of channels) {
            try {
                await syncChannel(channel);
                logger.info(`[CRON] Channel sync successful for ${channel.name}.`);
            } catch (error) {
                logger.error(`[CRON] Channel sync failed for ${channel.name}: ${error.message}`);
            }
        }

        // Instagram accounts
        await syncAllInstagramAccounts();
        logger.info("[CRON] Instagram accounts sync finished.");
    } catch (error) {
        logger.error(`[CRON] Error during scheduled sync: ${error.message}`);
    } finally {
        await releaseLock();
        logger.info("[CRON] Finished scheduled incremental sync.");
    }
};

let task;

const start = async () => {
    try {
        await connectDB();

        task = cron.schedule("0 */4 * * *", runIncrementalSync, { timezone: "Asia/Kolkata" });
        logger.info("[SCHEDULER] Incremental sync scheduled every 4 hours (Asia/Kolkata).");
    } catch (err) {
        logger.fatal({ err: err.message, stack: err.stack }, "[SCHEDULER] Startup failure");
        process.exit(1);
    }
};

const shutdown = async (signal) => {
    logger.info(`[SCHEDULER] ${signal} received. Shutting down...`);
    try {
        if (task) task.stop();
        await releaseLock();
        await Promise.allSettled([sequelize.close(), redisClient.quit()]);
    } finally {
        process.exit(0);
    }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "[SCHEDULER] Unhandled rejection");
});

start();