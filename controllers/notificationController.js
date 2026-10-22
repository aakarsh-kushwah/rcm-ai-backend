/**
 * @file controllers/notificationController.js
 * @description Notification API. This file does almost no work itself:
 *   - device register / unsubscribe  : tiny DB reads/writes
 *   - broadcast                      : validates, queues ONE job, returns 202 (web server load ~ 0)
 *   - actual FCM delivery            : workers/notificationWorker.js
 */

const { NotificationToken } = require("../models");
const { connection: redis } = require("../config/redis");
const push = require("../services/pushService");
const queue = require("../queues/notificationQueue");

const PLATFORMS = ["ANDROID", "IOS", "WEB", "DESKTOP"];
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // re-write an unchanged token at most once a day
const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_DATA_JSON = 2000; // FCM message limit is 4KB

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Allows "/path" or "https://..." only (blocks "//evil.com", "javascript:", etc). */
const normalizeActionUrl = (value) => {
    if (!value) return undefined;
    const url = String(value).trim();
    if (url.startsWith("/") && !url.startsWith("//")) return url;
    if (/^https:\/\//i.test(url)) return url;
    return null; // invalid
};

// ============================================================
// Event-driven helpers (used by other modules)
// ============================================================

/** Queues a broadcast. Returns immediately. Other modules can keep calling this. */
const broadcastNotification = async ({ title, body, imageUrl, actionUrl, dataPayload }) => {
    try {
        const { jobId } = await queue.enqueueBroadcast({ title, body, imageUrl, actionUrl, dataPayload });
        return { queued: true, jobId, successCount: 0, failureCount: 0 };
    } catch (err) {
        console.error(`🔥 [NOTIF] Could not queue broadcast: ${err.message}`);
        return { queued: false, successCount: 0, failureCount: 0 };
    }
};
exports.broadcastNotification = broadcastNotification;

/** Targeted push to one user. Queued; falls back to a direct send (small) if the queue is down. */
exports.sendTransactional = async (userId, payload) => {
    const content = {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.imageUrl,
        actionUrl: payload.url,
        dataPayload: payload.data,
    };
    try {
        await queue.enqueueTransactional(userId, content);
        return true;
    } catch (queueErr) {
        console.warn(`⚠️ [NOTIF] Queue unavailable, sending directly: ${queueErr.message}`);
        try {
            const result = await push.sendToUser(userId, content);
            return result.successCount > 0;
        } catch (err) {
            console.error("Transactional Push Failed:", err.message);
            return false;
        }
    }
};

// ============================================================
// 1. 🛰️ DEVICE REGISTRATION
// ============================================================
exports.registerDevice = async (req, res) => {
    const { token, platform, deviceMeta, fingerprint, preferences } = req.body || {};
    const userId = req.user ? req.user.id : null;

    if (typeof token !== "string" || token.length < 20 || token.length > 512) {
        return res.status(400).json({ success: false, message: "Invalid token" });
    }

    const upperPlatform = String(platform || "WEB").toUpperCase();
    const safePlatform = PLATFORMS.includes(upperPlatform) ? upperPlatform : "WEB";
    const now = new Date();

    try {
        let existing = await NotificationToken.findOne({ where: { token } });
        let type = "CREATED";

        if (!existing) {
            try {
                await NotificationToken.create({
                    token,
                    userId,
                    platform: safePlatform,
                    deviceMeta: isPlainObject(deviceMeta) ? deviceMeta : {},
                    deviceFingerprint: typeof fingerprint === "string" ? fingerprint.slice(0, 255) : null,
                    ...(isPlainObject(preferences) ? { preferences } : {}),
                    status: "ACTIVE",
                    failureCount: 0,
                    lastUsedAt: now,
                });
                console.log(`📲 [DEVICE SYNC] New token for user: ${userId || "Guest"}`);
                return res.status(200).json({ success: true, message: "Device registered", type });
            } catch (err) {
                // Two requests raced to insert the same token: fall through and update.
                if (err.name !== "SequelizeUniqueConstraintError") throw err;
                existing = await NotificationToken.findOne({ where: { token } });
                if (!existing) throw err;
            }
        }

        const isFresh = now.getTime() - new Date(existing.updatedAt).getTime() < REFRESH_AFTER_MS;
        const sameOwner = (existing.userId ?? null) === userId;
        const hasChanges = isPlainObject(preferences) || isPlainObject(deviceMeta) || typeof fingerprint === "string";

        if (isFresh && sameOwner && existing.status === "ACTIVE" && !hasChanges) {
            return res.status(200).json({ success: true, message: "Device already registered", type: "UNCHANGED" });
        }

        const updates = {
            userId,
            platform: safePlatform,
            status: "ACTIVE",
            failureCount: 0,
            lastUsedAt: now,
        };
        if (isPlainObject(preferences)) updates.preferences = preferences; // never reset user's choices silently
        if (isPlainObject(deviceMeta)) updates.deviceMeta = deviceMeta;
        if (typeof fingerprint === "string") updates.deviceFingerprint = fingerprint.slice(0, 255);

        await existing.update(updates);
        type = "UPDATED";

        return res.status(200).json({ success: true, message: "Device updated", type });
    } catch (error) {
        console.error("🔥 [DEVICE SYNC]:", error.message);
        return res.status(503).json({ success: false, message: "Could not register device, please retry" });
    }
};

// ============================================================
// 2. 🔕 UNSUBSCRIBE (dashboard bell toggle OFF)
// ============================================================
exports.unregisterDevice = async (req, res) => {
    const { token } = req.body || {};
    const userId = req.user ? req.user.id : null;

    if (typeof token !== "string" || !token) {
        return res.status(400).json({ success: false, message: "Token required" });
    }

    try {
        // Only the owner can switch off their own token
        const [affected] = await NotificationToken.update({ status: "INACTIVE" }, { where: { token, userId } });
        return res.status(200).json({ success: true, message: "Notifications disabled", affected });
    } catch (error) {
        console.error("🔥 [UNSUBSCRIBE]:", error.message);
        return res.status(503).json({ success: false, message: "Could not update, please retry" });
    }
};

// ============================================================
// 3. 🚀 BROADCAST (admin only, 202 Accepted)
// ============================================================
exports.sendTitanBroadcast = async (req, res) => {
    if (!push.isFirebaseReady()) {
        return res.status(503).json({ success: false, message: "Notification system offline (Firebase not configured)" });
    }

    const { title, body, imageUrl, actionUrl, dataPayload } = req.body || {};

    if (typeof title !== "string" || typeof body !== "string" || !title.trim() || !body.trim()) {
        return res.status(400).json({ success: false, message: "Title and body are required" });
    }
    if (title.length > MAX_TITLE || body.length > MAX_BODY) {
        return res
            .status(400)
            .json({ success: false, message: `Title max ${MAX_TITLE} chars, body max ${MAX_BODY} chars` });
    }

    let cleanImage;
    if (imageUrl) {
        cleanImage = push.sanitizeImageUrl(imageUrl);
        if (!cleanImage) {
            return res.status(400).json({ success: false, message: "imageUrl must be a valid https URL" });
        }
    }

    const cleanAction = normalizeActionUrl(actionUrl);
    if (cleanAction === null) {
        return res
            .status(400)
            .json({ success: false, message: "actionUrl must start with / or be a valid https URL" });
    }

    if (dataPayload !== undefined) {
        if (!isPlainObject(dataPayload) || JSON.stringify(dataPayload).length > MAX_DATA_JSON) {
            return res.status(400).json({ success: false, message: "dataPayload must be a small object" });
        }
    }

    try {
        const { jobId } = await queue.enqueueBroadcast(
            {
                title: title.trim(),
                body: body.trim(),
                imageUrl: cleanImage,
                actionUrl: cleanAction,
                dataPayload,
            },
            req.user ? req.user.id : null
        );

        return res.status(202).json({
            success: true,
            message: "Broadcast accepted. Delivery is running in the background.",
            jobId,
        });
    } catch (err) {
        console.error(`🔥 [BROADCAST] Queue unavailable: ${err.message}`);
        return res.status(503).json({ success: false, message: "Queue unavailable, please retry in a moment" });
    }
};

// ============================================================
// 4. 📊 BROADCAST PROGRESS (admin only)
// ============================================================
exports.getBroadcastStatus = async (req, res) => {
    const { jobId } = req.params;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
        return res.status(400).json({ success: false, message: "Invalid job id" });
    }

    try {
        const [stats, state] = await Promise.all([
            redis.hgetall(queue.statsKey(jobId)),
            queue.getJobState(jobId).catch(() => null),
        ]);

        const num = (v) => Number(v || 0);
        const total = num(stats.total);
        const batches = num(stats.batches);
        const batchesDone = num(stats.batchesDone);

        return res.status(200).json({
            success: true,
            jobId,
            queueState: state || "unknown",
            status: stats.status || (state ? "queued" : "unknown"),
            totalTokens: total,
            batches,
            batchesDone,
            progressPercent: batches > 0 ? Math.min(100, Math.round((batchesDone / batches) * 100)) : 0,
            success_count: num(stats.success),
            failure_count: num(stats.failure),
            purged_dead_tokens: num(stats.purged),
        });
    } catch (err) {
        return res.status(503).json({ success: false, message: "Status unavailable" });
    }
};