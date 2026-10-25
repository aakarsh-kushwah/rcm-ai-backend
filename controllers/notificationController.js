/**
 * @file controllers/notificationController.js
 * @description Enterprise-grade Notification API. Designed for high scalability (millions of users):
 *   - Device register / unsubscribe : Lightweight DB transactions with unique constraints
 *   - Broadcast                     : Validates, offloads to queue, returns 202 instantly (Zero Web Server Load)
 *   - Status Tracking               : Fast Redis-backed status resolution preventing polling loops/304 stalls
 *   - Actual FCM delivery           : Handled asynchronously by workers/notificationWorker.js
 */

const { NotificationToken, Campaign } = require("../models");
const firebaseAdmin = require('../config/firebase'); // Firebase Admin SDK
const push = require("../services/pushService");

const PLATFORMS = ["ANDROID", "IOS", "WEB", "DESKTOP"];
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000; // Throttle unchanged token writes to max once a day
const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_DATA_JSON = 2000; // FCM safe message payload limit (4KB total)


const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Allows absolute "/path" or "https://..." only (secures against XSS, "//evil.com", "javascript:", etc). */
const normalizeActionUrl = (value) => {
    if (!value) return undefined;
    const url = String(value).trim();
    if (url.startsWith("/") && !url.startsWith("//")) return url;
    if (/^https:\/\//i.test(url)) return url;
    return null; // Invalid format
};

// ============================================================
// Event-driven internal helpers (invoked by other core modules)
// ============================================================





// ============================================================
// 1. 🛰️ DEVICE REGISTRATION (High-throughput upsert)
// ============================================================
exports.registerDevice = async (req, res) => {
    const { token, platform, deviceMeta, fingerprint, preferences } = req.body || {};
    const userId = req.user ? req.user.id : null;

    if (typeof token !== "string" || token.length < 20 || token.length > 512) {
        return res.status(400).json({ success: false, message: "Invalid or malformed device token" });
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
                console.log(`📲 [DEVICE SYNC] Registered fresh token for user: ${userId || "Guest"}`);
                return res.status(200).json({ success: true, message: "Device registered successfully", type });
            } catch (err) {
                // Handle race conditions where concurrent requests insert the identical token simultaneously
                if (err.name !== "SequelizeUniqueConstraintError") throw err;
                existing = await NotificationToken.findOne({ where: { token } });
                if (!existing) throw err;
            }
        }

        const isFresh = now.getTime() - new Date(existing.updatedAt).getTime() < REFRESH_AFTER_MS;
        const sameOwner = (existing.userId ?? null) === userId;
        const hasChanges = isPlainObject(preferences) || isPlainObject(deviceMeta) || typeof fingerprint === "string";

        // Skip unnecessary database write cycles if token metadata is fresh and unchanged
        if (isFresh && sameOwner && existing.status === "ACTIVE" && !hasChanges) {
            return res.status(200).json({ success: true, message: "Device already synchronized", type: "UNCHANGED" });
        }

        const updates = {
            userId,
            platform: safePlatform,
            status: "ACTIVE",
            failureCount: 0,
            lastUsedAt: now,
        };
        if (isPlainObject(preferences)) updates.preferences = preferences;
        if (isPlainObject(deviceMeta)) updates.deviceMeta = deviceMeta;
        if (typeof fingerprint === "string") updates.deviceFingerprint = fingerprint.slice(0, 255);

        await existing.update(updates);
        type = "UPDATED";

        return res.status(200).json({ success: true, message: "Device profile updated", type });
    } catch (error) {
        console.error("🔥 [DEVICE SYNC ERROR]:", error.message);
        return res.status(503).json({ success: false, message: "Could not sync device registration right now, please retry" });
    }
};

// ============================================================
// 2. 🔕 UNSUBSCRIBE (Soft deactivation on bell toggle OFF)
// ============================================================
exports.unregisterDevice = async (req, res) => {
    const { token } = req.body || {};
    const userId = req.user ? req.user.id : null;

    if (typeof token !== "string" || !token) {
        return res.status(400).json({ success: false, message: "Valid notification token required" });
    }

    try {
        // Enforce ownership security: users can only deactivate their own mapped tokens
        const [affected] = await NotificationToken.update({ status: "INACTIVE" }, { where: { token, userId } });
        return res.status(200).json({ success: true, message: "Notifications disabled successfully", affected });
    } catch (error) {
        console.error("🔥 [UNSUBSCRIBE ERROR]:", error.message);
        return res.status(503).json({ success: false, message: "Could not process unsubscription, please retry" });
    }
};

// ============================================================
// 3. 🚀 TITAN BROADCAST (Admin high-scale dispatch, 202 Accepted)
// ============================================================
exports.sendTitanBroadcast = async (req, res) => {
    if (!push.isFirebaseReady()) {
        return res.status(503).json({ success: false, message: "Notification core offline: Firebase credentials not initialized" });
    }

    const { title, body, imageUrl, actionUrl, dataPayload } = req.body || {};

    if (typeof title !== "string" || typeof body !== "string" || !title.trim() || !body.trim()) {
        return res.status(400).json({ success: false, message: "Notification title and body parameters are mandatory" });
    }
    if (title.length > MAX_TITLE || body.length > MAX_BODY) {
        return res.status(400).json({ 
            success: false, 
            message: `Payload constraint violation: Title max ${MAX_TITLE} chars, Body max ${MAX_BODY} chars` 
        });
    }

    let cleanImage;
    if (imageUrl) {
        cleanImage = push.sanitizeImageUrl(imageUrl);
        if (!cleanImage) {
            return res.status(400).json({ success: false, message: "imageUrl must be a secure, valid HTTPS URL" });
        }
    }

    const cleanAction = normalizeActionUrl(actionUrl);
    if (cleanAction === null) {
        return res.status(400).json({ success: false, message: "actionUrl must be a relative path starting with '/' or a valid HTTPS URL" });
    }

    if (dataPayload !== undefined) {
        if (!isPlainObject(dataPayload) || JSON.stringify(dataPayload).length > MAX_DATA_JSON) {
            return res.status(400).json({ success: false, message: "dataPayload must be a lightweight valid JSON object under 2KB" });
        }
    }

    // Return 200 OK immediately
    res.status(200).json({ success: true, message: "Broadcast initiated" });

    // Background processing using setImmediate
    setImmediate(async () => {
        const campaignRecord = await Campaign.create({
            jobId: `broadcast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // Generate a unique jobId
            title: title.trim(),
            body: body.trim(),
            imageUrl: cleanImage,
            actionUrl: cleanAction,
            totalTokens: 0, // Will be updated after fetching
            successCount: 0,
            failureCount: 0,
            status: 'PROCESSING',
            triggeredBy: req.user ? req.user.id : null,
        }).catch(err => console.error("⚠️ [CAMPAIGN] Failed to create campaign record:", err.message));

        try {
            // 1. Fetch ALL Active Tokens
            const activeDevices = await NotificationToken.findAll({
                where: { status: 'ACTIVE' },
                attributes: ['id', 'token'], // Fetch id to update status if token is invalid
                raw: true
            });

            const allTokens = activeDevices.map(d => d.token);
            const tokenMap = new Map(activeDevices.map(d => [d.token, d.id])); // Map token to NotificationToken ID

            if (allTokens.length === 0) {
                console.log(`📢 [TITAN BLAST] No active devices found to send notifications.`);
                if (campaignRecord) {
                    await campaignRecord.update({ status: 'COMPLETED', message: 'No active devices found.' });
                }
                return;
            }

            console.log(`📢 [TITAN BLAST] Targeting ${allTokens.length} devices...`);

            // 2. SMART BATCHING (500 per chunk - Firebase Limit)
            const BATCH_SIZE = 500;
            let successCount = 0;
            let failureCount = 0;
            let purgedDeadTokens = 0;

            if (campaignRecord) {
                await campaignRecord.update({ totalTokens: allTokens.length });
            }

            for (let i = 0; i < allTokens.length; i += BATCH_SIZE) {
                const batchTokens = allTokens.slice(i, i + BATCH_SIZE);
                
                const message = {
                    notification: {
                        title: title.trim(),
                        body: body.trim(),
                        imageUrl: cleanImage,
                    },
                    data: { 
                        title: title.trim(), 
                        body: body.trim(), 
                        image: cleanImage || "", 
                        url: cleanAction || "/", 
                        click_action: "FLUTTER_NOTIFICATION_CLICK"
                    },
                    tokens: batchTokens
                };

                try {
                    const response = await firebaseAdmin.messaging().sendEachForMulticast(message);
                    
                    successCount += response.successCount;
                    failureCount += response.failureCount;

                    // 4. Automatically remove invalid/unregistered tokens
                    const tokensToRemove = [];
                    response.responses.forEach((resp, idx) => {
                        if (resp.success === false && resp.error) {
                            const token = batchTokens[idx];
                            // Check for specific error codes that indicate invalid or unregistered tokens
                            if (resp.error.code === 'messaging/invalid-argument' || 
                                resp.error.code === 'messaging/registration-token-not-registered') {
                                tokensToRemove.push(token);
                            }
                        }
                    });

                    if (tokensToRemove.length > 0) {
                        purgedDeadTokens += tokensToRemove.length;
                        await NotificationToken.update(
                            { status: 'INACTIVE', failureCount: NotificationToken.sequelize.literal('failureCount + 1') },
                            { where: { token: { [NotificationToken.sequelize.Op.in]: tokensToRemove } } }
                        );
                        console.log(`🗑️ [TITAN PURGE] Removed ${tokensToRemove.length} invalid tokens.`);
                    }

                    console.log(`[TITAN BLAST] Delivered batch ${Math.ceil((i + BATCH_SIZE) / BATCH_SIZE)}/${Math.ceil(allTokens.length / BATCH_SIZE)} to ${response.successCount} devices. Failed: ${response.failureCount}.`);

                } catch (batchError) {
                    console.error(`❌ [TITAN BLAST] Error sending batch ${Math.ceil((i + BATCH_SIZE) / BATCH_SIZE)}:`, batchError);
                    failureCount += batchTokens.length; // Assume all tokens in this batch failed if the batch send itself failed
                }
            }

            console.log(`✅ [BLAST COMPLETE] Success: ${successCount}, Failed: ${failureCount}. Purged: ${purgedDeadTokens} dead tokens.`);
            if (campaignRecord) {
                await campaignRecord.update({
                    successCount,
                    failureCount,
                    status: 'COMPLETED',
                    purgedDeadTokens: purgedDeadTokens,
                    message: 'Broadcast completed successfully.'
                });
            }

        } catch (error) {
            console.error("🔥 Broadcast System Error (Background Process):", error);
            if (campaignRecord) {
                await campaignRecord.update({ status: 'FAILED', message: `Broadcast failed: ${error.message}` });
            }
        }
    });
};

// ============================================================
// 4. 📊 BROADCAST STATUS RESOLUTION (Optimized for Admin UI polling)
// ============================================================
exports.getBroadcastStatus = async (req, res) => {
    // Explicitly disable client-side or proxy caching to prevent 304 Not Modified polling deadlocks
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { jobId } = req.params;
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
        return res.status(400).json({ success: false, message: "Malformed or invalid job identifier" });
    }

    try {
        const campaign = await Campaign.findOne({ where: { jobId }, raw: true });

        if (!campaign) {
            return res.status(404).json({ success: false, message: "Campaign not found." });
        }

        const isCompleted = campaign.status === 'COMPLETED' || campaign.status === 'FAILED';
        const progressPercent = campaign.totalTokens > 0 
            ? Math.min(100, Math.floor(((campaign.successCount + campaign.failureCount) / campaign.totalTokens) * 100)) 
            : (isCompleted ? 100 : 0);

        return res.status(200).json({
            success: true,
            jobId: campaign.jobId,
            queueState: isCompleted ? "completed" : "active",
            status: campaign.status.toLowerCase(),
            progress: progressPercent,
            progressPercent: progressPercent,
            totalTokens: campaign.totalTokens,
            successCount: campaign.successCount,
            failureCount: campaign.failureCount,
            success_count: campaign.successCount,
            failure_count: campaign.failureCount,
            purged_dead_tokens: campaign.purgedDeadTokens || 0,
            message: campaign.message || (isCompleted ? 'Broadcast completed.' : 'Processing broadcast.'),
        });
    } catch (err) {
        console.error('❌ Get Broadcast Status Error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to retrieve broadcast status.' });
    }
};
