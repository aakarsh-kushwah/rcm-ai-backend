/**
 * @file queues/notificationQueue.js
 * @description BullMQ producer side. The web server only calls these helpers (a few ms of work).
 */

const crypto = require("crypto");

const { Queue } = require("bullmq");
const { Op } = require("sequelize");
const redisConfig = require("../config/redis");
const push = require("../services/pushService");
const { NotificationToken } = require("../models");

const QUEUE_NAME = "push-notifications";
const QUEUE_TIMEOUT_MS = 3000;

// BullMQ: lower number = higher priority
const PRIORITY = { TRANSACTIONAL: 1, BROADCAST: 10 };



let queue = null;

const getQueue = () => {
    if (!queue) {
        queue = new Queue(QUEUE_NAME, {
            connection: redisConfig.connection,
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

    try {
        const job = await withTimeout(
            getQueue().add("broadcast", { content, triggeredBy }, { jobId, priority: PRIORITY.BROADCAST })
        );
        return { jobId: job.id };
    } catch (err) {
        console.warn(`⚠️ [NOTIF-QUEUE] Redis/Queue offline for broadcast (${err.message}), falling back to direct push execution.`);

        // Fall back to executing notification delivery directly using services/pushService.js in background
        (async () => {
            try {
                let lastId = 0;
                while (true) {
                    const rows = await NotificationToken.findAll({
                        where: { id: { [Op.gt]: lastId }, status: "ACTIVE" },
                        attributes: ["id"],
                        order: [["id", "ASC"]],
                        limit: 500,
                        raw: true,
                    });
                    if (!rows.length) break;
                    const afterId = lastId;
                    const upToId = rows[rows.length - 1].id;
                    lastId = upToId;
                    await push.sendBatchByIdRange({ afterId, upToId, content });
                }
                console.log(`[NOTIF-QUEUE] Offline fallback broadcast complete for jobId: ${jobId}`);
            } catch (fallbackErr) {
                console.error(`🔥 [NOTIF-QUEUE] Offline fallback broadcast failed: ${fallbackErr.message}`);
            }
        })().catch(() => {});

        return { jobId };
    }
};

const enqueueTransactional = async (userId, content) => {
    try {
        const job = await withTimeout(
            getQueue().add("transactional", { userId, content }, { priority: PRIORITY.TRANSACTIONAL })
        );
        return { jobId: job.id };
    } catch (err) {
        console.warn(`⚠️ [NOTIF-QUEUE] Redis/Queue offline for transactional (${err.message}), falling back to direct push execution.`);

        // Fall back to executing direct push for user
        (async () => {
            try {
                await push.sendToUser(userId, content);
                console.log(`[NOTIF-QUEUE] Offline fallback transactional sent for user: ${userId}`);
            } catch (fallbackErr) {
                console.error(`🔥 [NOTIF-QUEUE] Offline fallback transactional failed: ${fallbackErr.message}`);
            }
        })().catch(() => {});

        return { jobId: `mock_trans_${Date.now()}` };
    }
};

const getJobState = async (jobId) => {
    try {
        const job = await withTimeout(getQueue().getJob(jobId));
        return job ? job.getState() : "completed";
    } catch (err) {
        return "completed";
    }
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
