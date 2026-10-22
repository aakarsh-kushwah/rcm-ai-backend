/**
 * @file queues/notificationQueue.js
 * @description BullMQ producer side. The web server only calls these helpers (a few ms of work).
 */

const crypto = require("crypto");
const IORedis = require("ioredis");
const { Queue } = require("bullmq");
const redisConfig = require("../config/redis");

const QUEUE_NAME = "push-notifications";
const QUEUE_TIMEOUT_MS = 3000;

// BullMQ: lower number = higher priority
const PRIORITY = { TRANSACTIONAL: 1, BROADCAST: 10 };

/** Uses createBullConnection when available, otherwise builds a BullMQ-safe connection itself. */
const makeBullConnection = (label) => {
    if (typeof redisConfig.createBullConnection === "function") {
        return redisConfig.createBullConnection(label);
    }
    const url = process.env.REDIS_URL || process.env.REDIS_CLOUD_URL || "redis://127.0.0.1:6379";
    return new IORedis(url, {
        maxRetriesPerRequest: null, // required by BullMQ
        tls: url.startsWith("rediss://") ? {} : undefined,
        retryStrategy: (times) => Math.min(times * 200, 3000),
    });
};

let queue = null;

const getQueue = () => {
    if (!queue) {
        queue = new Queue(QUEUE_NAME, {
            connection: makeBullConnection("bull-producer"),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: "exponential", delay: 5000 },
                removeOnComplete: { age: 3600, count: 5000 },
                removeOnFail: { age: 24 * 3600, count: 5000 },
            },
        });
        queue.on("error", (err) => console.warn(`⚠️ [NOTIF-QUEUE] ${err.message}`));
    }
    return queue;
};

/** Never lets an API request hang if Redis is down. */
const withTimeout = (promise, ms = QUEUE_TIMEOUT_MS) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Notification queue timeout")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const statsKey = (jobId) => `notif:stats:${jobId}`;

/** Same payload within the same minute gets the same jobId, so a double-click cannot send twice. */
const enqueueBroadcast = async (content, triggeredBy = null) => {
    const hash = crypto
        .createHash("sha1")
        .update(JSON.stringify([content.title, content.body, content.imageUrl, content.actionUrl]))
        .digest("hex")
        .slice(0, 16);
    const jobId = `broadcast_${hash}_${Math.floor(Date.now() / 60000)}`;

    const job = await withTimeout(
        getQueue().add("broadcast", { content, triggeredBy }, { jobId, priority: PRIORITY.BROADCAST })
    );
    return { jobId: job.id };
};

const enqueueTransactional = async (userId, content) => {
    const job = await withTimeout(
        getQueue().add("transactional", { userId, content }, { priority: PRIORITY.TRANSACTIONAL })
    );
    return { jobId: job.id };
};

const getJobState = async (jobId) => {
    const job = await withTimeout(getQueue().getJob(jobId));
    return job ? job.getState() : null;
};

module.exports = {
    QUEUE_NAME,
    PRIORITY,
    getQueue,
    withTimeout,
    statsKey,
    enqueueBroadcast,
    enqueueTransactional,
    getJobState,
};