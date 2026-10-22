/**
 * @file workers/notificationWorker.js
 * @description Push fan-out worker. Run as its own process: npm run worker:notification
 */

require("dotenv").config();

const IORedis = require("ioredis");
const { Worker } = require("bullmq");
const { Op } = require("sequelize");

const { logger } = require("../utils/logger");
const { connectDB, sequelize, NotificationToken } = require("../models");
const redisConfig = require("../config/redis");
const { QUEUE_NAME, PRIORITY, getQueue, statsKey } = require("../queues/notificationQueue");
const push = require("../services/pushService");

const redis = redisConfig.connection;

const BATCH_SIZE = 500; // FCM multicast limit
const BULK_ADD_SIZE = 100;
const STATS_TTL_SECONDS = 24 * 3600;
const CONCURRENCY = Number(process.env.NOTIF_WORKER_CONCURRENCY) || 10;
const BATCHES_PER_SEC = Number(process.env.NOTIF_BATCHES_PER_SEC) || 10;

const makeBullConnection = () => {
    if (typeof redisConfig.createBullConnection === "function") {
        return redisConfig.createBullConnection("bull-worker");
    }
    const url = process.env.REDIS_URL || process.env.REDIS_CLOUD_URL || "redis://127.0.0.1:6379";
    return new IORedis(url, {
        maxRetriesPerRequest: null, // required by BullMQ
        tls: url.startsWith("rediss://") ? {} : undefined,
        retryStrategy: (times) => Math.min(times * 200, 3000),
    });
};

const recordStats = async (parentId, result) => {
    try {
        const key = statsKey(parentId);
        await redis
            .multi()
            .hincrby(key, "success", result.successCount)
            .hincrby(key, "failure", result.failureCount)
            .hincrby(key, "purged", result.purgedCount)
            .hincrby(key, "batchesDone", 1)
            .expire(key, STATS_TTL_SECONDS)
            .exec();
    } catch (err) {
        logger.warn({ err: err.message }, "[NOTIF-WORKER] Could not record stats");
    }
};

// broadcast: walks token ids and queues one small "send-batch" job per 500 tokens
const processBroadcast = async (job) => {
    const { content } = job.data;
    const queue = getQueue();
    const key = statsKey(job.id);

    try {
        await redis
            .multi()
            .hset(key, "status", "fanning_out", "startedAt", String(Date.now()))
            .expire(key, STATS_TTL_SECONDS)
            .exec();
    } catch (e) {
        /* stats are optional */
    }

    let lastId = 0;
    let totalTokens = 0;
    let totalBatches = 0;
    let pending = [];

    const flush = async () => {
        if (!pending.length) return;
        await queue.addBulk(pending);
        pending = [];
    };

    while (true) {
        const rows = await NotificationToken.findAll({
            where: { id: { [Op.gt]: lastId }, status: "ACTIVE" },
            attributes: ["id"],
            order: [["id", "ASC"]],
            limit: BATCH_SIZE,
            raw: true,
        });
        if (!rows.length) break;

        const afterId = lastId;
        const upToId = rows[rows.length - 1].id;
        lastId = upToId;

        totalTokens += rows.length;
        totalBatches += 1;

        pending.push({
            name: "send-batch",
            data: { afterId, upToId, content, parentId: job.id },
            opts: { jobId: `${job.id}_${afterId}`, priority: PRIORITY.BROADCAST },
        });

        if (pending.length >= BULK_ADD_SIZE) {
            await flush();
            await job.updateProgress({ batches: totalBatches, tokens: totalTokens });
        }
    }
    await flush();

    try {
        await redis.hset(key, "status", "sending", "total", String(totalTokens), "batches", String(totalBatches));
    } catch (e) {
        /* optional */
    }

    logger.info({ jobId: job.id, totalTokens, totalBatches }, "[NOTIF-WORKER] Broadcast fan-out complete");
    return { totalTokens, totalBatches };
};

// send-batch: one multicast of up to 500 tokens
const processBatch = async (job) => {
    const { afterId, upToId, content, parentId } = job.data;
    const result = await push.sendBatchByIdRange({ afterId, upToId, content });
    if (parentId) await recordStats(parentId, result);
    return result;
};

// transactional: one user, all devices
const processTransactional = async (job) => {
    const { userId, content } = job.data;
    return push.sendToUser(userId, content);
};

const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
        switch (job.name) {
            case "broadcast":
                return processBroadcast(job);
            case "send-batch":
                return processBatch(job);
            case "transactional":
                return processTransactional(job);
            default:
                throw new Error(`Unknown job type: ${job.name}`);
        }
    },
    {
        connection: makeBullConnection(),
        concurrency: CONCURRENCY,
        limiter: { max: BATCHES_PER_SEC, duration: 1000 },
        lockDuration: 60 * 1000,
    }
);

worker.on("failed", (job, err) => {
    logger.error(
        { jobId: job && job.id, name: job && job.name, attempts: job && job.attemptsMade, err: err.message },
        "[NOTIF-WORKER] Job failed"
    );
});
worker.on("error", (err) => logger.warn({ err: err.message }, "[NOTIF-WORKER] Worker error"));

const start = async () => {
    try {
        await connectDB();
        if (!push.isFirebaseReady()) {
            logger.warn("[NOTIF-WORKER] Firebase is not initialised. Jobs will retry until it is configured.");
        }
        logger.info({ concurrency: CONCURRENCY, batchesPerSec: BATCHES_PER_SEC }, "[NOTIF-WORKER] Notification worker online");
    } catch (err) {
        logger.fatal({ err: err.message, stack: err.stack }, "[NOTIF-WORKER] Startup failure");
        process.exit(1);
    }
};

const shutdown = async (signal) => {
    logger.info(`[NOTIF-WORKER] ${signal} received. Finishing running jobs...`);
    const forceTimer = setTimeout(() => process.exit(1), 30 * 1000);
    forceTimer.unref();
    try {
        await worker.close();
        await getQueue().close();
        await Promise.allSettled([sequelize.close(), redis.quit()]);
    } finally {
        process.exit(0);
    }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "[NOTIF-WORKER] Unhandled rejection");
});

start();