/**
 * @file services/pushService.js
 * @description Rich WebPush message builder + FCM delivery + dead token purge.
 */

const { Op } = require("sequelize");
const { NotificationToken } = require("../models");

const DEFAULT_TITLE = "RCM AI Update";
const DEFAULT_ACTION_PATH = "/dashboard";
const SITE_URL = (process.env.FRONTEND_URL || process.env.CLIENT_URL || "https://rcmai.in").replace(/\/+$/, "");

// Lazy Firebase loader: never crashes the server on boot
const getFirebase = () => {
    try {
        const { admin } = require("../config/firebase");
        if (!admin || !admin.apps.length) return null;
        return admin;
    } catch (e) {
        return null;
    }
};

const isFirebaseReady = () => Boolean(getFirebase());

/** FCM `webpush.fcmOptions.link` must be an absolute https URL. */
const toAbsoluteUrl = (value) => {
    const raw = String(value || DEFAULT_ACTION_PATH).trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${SITE_URL}${raw.startsWith("/") ? raw : `/${raw}`}`;
};

/** Banner images must be https, otherwise Chrome/FCM ignores or rejects them. */
const sanitizeImageUrl = (imageUrl) => {
    if (!imageUrl) return undefined;
    const url = String(imageUrl).trim();
    return /^https:\/\//i.test(url) ? url : undefined;
};

/** FCM `data` values must all be strings. */
const stringifyData = (obj) =>
    Object.fromEntries(
        Object.entries(obj || {})
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])
    );

/** Tokens that FCM says are permanently dead. */
const isDeadTokenError = (error) => {
    if (!error) return false;
    const code = error.code || "";
    const message = String(error.message || "").toLowerCase();
    return (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        message.includes("unregistered") ||
        message.includes("notregistered")
    );
};

/** Branded notification: logo, badge, banner, action buttons, deep link. */
const buildRichMessage = ({ title, body, imageUrl, actionUrl, dataPayload, tokens }) => {
    const finalTitle = title || DEFAULT_TITLE;
    const finalBody = body || "";
    const finalImage = sanitizeImageUrl(imageUrl);
    const finalActionPath = actionUrl || DEFAULT_ACTION_PATH;

    const notification = { title: finalTitle, body: finalBody };
    if (finalImage) notification.imageUrl = finalImage;

    const webNotification = {
        title: finalTitle,
        body: finalBody,
        icon: "/rcm-logo-192.png",
        badge: "/badge-72x72.png",
        vibrate: [200, 100, 200],
        requireInteraction: true,
        actions: [
            { action: "open_url", title: "🚀 Open App" },
            { action: "dismiss", title: "Dismiss" },
        ],
    };
    if (finalImage) webNotification.image = finalImage;

    return {
        notification,
        webpush: {
            headers: { Urgency: "high", TTL: "86400" },
            notification: webNotification,
            fcmOptions: { link: toAbsoluteUrl(finalActionPath) },
        },
        data: {
            ...stringifyData(dataPayload),
            title: String(finalTitle),
            body: String(finalBody),
            image: String(finalImage || ""),
            url: String(finalActionPath),
        },
        tokens,
    };
};

/** Removes dead tokens from DB. Other failures are logged as ONE summary line. */
const purgeDeadTokens = async (deviceTokens, response) => {
    const deadTokens = [];
    const otherErrors = {};

    response.responses.forEach((resp, index) => {
        if (resp.success) return;
        if (isDeadTokenError(resp.error)) {
            deadTokens.push(deviceTokens[index]);
        } else {
            const code = (resp.error && resp.error.code) || "unknown";
            otherErrors[code] = (otherErrors[code] || 0) + 1;
        }
    });

    if (Object.keys(otherErrors).length > 0) {
        console.warn(`[Notification] Non-dead delivery failures: ${JSON.stringify(otherErrors)}`);
    }

    if (deadTokens.length > 0) {
        try {
            await NotificationToken.destroy({ where: { token: deadTokens } });
            console.log(`[Notification] Purged ${deadTokens.length} dead tokens from database.`);
        } catch (err) {
            console.error(`[Notification] Dead token purge failed: ${err.message}`);
            return 0;
        }
    }
    return deadTokens.length;
};

/** Sends one multicast (max 500 tokens) and purges dead tokens. */
const sendToTokens = async (deviceTokens, content) => {
    if (!deviceTokens.length) return { successCount: 0, failureCount: 0, purgedCount: 0 };

    const admin = getFirebase();
    if (!admin) throw new Error("Firebase is not configured");

    const response = await admin
        .messaging()
        .sendEachForMulticast(buildRichMessage({ ...content, tokens: deviceTokens }));

    let purgedCount = 0;
    if (response.failureCount > 0) purgedCount = await purgeDeadTokens(deviceTokens, response);

    return { successCount: response.successCount, failureCount: response.failureCount, purgedCount };
};

/** One broadcast batch: tokens with id in (afterId, upToId]. */
const sendBatchByIdRange = async ({ afterId, upToId, content }) => {
    const rows = await NotificationToken.findAll({
        where: { id: { [Op.gt]: afterId, [Op.lte]: upToId }, status: "ACTIVE" },
        attributes: ["id", "token"],
        raw: true,
    });
    return sendToTokens(rows.map((r) => r.token), content);
};

/** All active devices of a single user. */
const sendToUser = async (userId, content) => {
    const rows = await NotificationToken.findAll({
        where: { userId, status: "ACTIVE" },
        attributes: ["token"],
        raw: true,
    });
    return sendToTokens(rows.map((r) => r.token), content);
};

module.exports = {
    getFirebase,
    isFirebaseReady,
    toAbsoluteUrl,
    sanitizeImageUrl,
    buildRichMessage,
    sendToTokens,
    sendBatchByIdRange,
    sendToUser,
};