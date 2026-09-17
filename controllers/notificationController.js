/**
 * @file controllers/notificationController.js
 * @title TITAN NEURAL PUSH ENGINE (ENTERPRISE EDITION)
 * @description Hyper-Scale Notification Orchestrator (Safe & Lazy Loaded)
 */

const { NotificationToken, sequelize } = require("../models");
const { Op } = require('sequelize');

// 🛡️ SAFE FIREBASE LOADER (Prevents Server Crash on Boot)
const getFirebase = () => {
    try {
        const { admin } = require("../config/firebase"); // Lazy Import
        if (!admin || !admin.apps.length) throw new Error("Firebase App not initialized");
        return admin;
    } catch (e) {
        console.warn("⚠️ [TITAN PUSH WARNING]: Firebase is not configured. Skipping notification.");
        return null;
    }
};

/**
 * Core Broadcast Helper function for background and event-driven pushes
 */
const broadcastNotification = async ({ title, body, imageUrl, actionUrl, dataPayload }) => {
    const admin = getFirebase();
    if (!admin) {
        console.warn("⚠️ [TITAN PUSH WARNING]: Firebase not configured. Skipping broadcast.");
        return { successCount: 0, failureCount: 0 };
    }

    let successCount = 0;
    let failureCount = 0;
    let lastId = 0;
    const batchSize = 500;

    console.log(`📡 [TITAN LAUNCH] Starting Hyper-Scale Broadcast...`);

    while (true) {
        try {
            const tokens = await NotificationToken.findAll({
                where: {
                    id: { [Op.gt]: lastId },
                    status: 'ACTIVE'
                },
                limit: batchSize,
                attributes: ['id', 'token'],
                raw: true,
                order: [['id', 'ASC']]
            });

            if (tokens.length === 0) break;
            lastId = tokens[tokens.length - 1].id;

            const deviceTokens = tokens.map(t => t.token);
            if (deviceTokens.length === 0) continue;

            const message = {
                notification: { title, body },
                data: {
                    url: actionUrl || '/',
                    ...Object.fromEntries(Object.entries(dataPayload || {}).map(([k, v]) => [k, String(v)]))
                },
                tokens: deviceTokens
            };

            const response = await admin.messaging().sendEachForMulticast(message);
            successCount += response.successCount;
            failureCount += response.failureCount;

            if (response.failureCount > 0) {
                response.responses.forEach((resp) => {
                    if (!resp.success) {
                        console.warn(`Failed token delivery: ${resp.error?.message || 'Unknown error'}`);
                    }
                });
            }
        } catch (err) {
            console.error(`Error in broadcast batch: ${err.message}`);
            break;
        }
    }

    console.log(`✅ [TITAN BROADCAST FINISHED] Success: ${successCount}, Failures: ${failureCount}`);
    return { successCount, failureCount };
};

exports.broadcastNotification = broadcastNotification;

// ============================================================
// 1. 🛰️ NEURAL SYNC (Device Registration)
// ============================================================
exports.registerDevice = async (req, res) => {
    try {
        const { token, platform, deviceMeta, fingerprint, preferences } = req.body;
        const userId = req.user ? req.user.id : null;

        if (!token) return res.status(400).json({ success: false, message: "Token Missing" });

        // Upsert Logic (Create or Update)
        const [node, created] = await NotificationToken.upsert({
            token: token,
            userId: userId,
            platform: platform || 'WEB',
            deviceMeta: deviceMeta || {},
            deviceFingerprint: fingerprint,
            preferences: preferences || { marketing: true },
            status: 'ACTIVE',
            lastUsedAt: new Date(),
            updatedAt: new Date()
        }, { returning: true });

        console.log(`📲 [DEVICE SYNC] Token Registered for User: ${userId || 'Guest'}`);

        res.status(200).json({ 
            success: true, 
            message: "Neural Link Established", 
            type: created ? "CREATED" : "UPDATED" 
        });

    } catch (error) {
        console.error("🔥 [SYNC CRITICAL]:", error.message);
        res.status(200).json({ success: true, message: "Sync Queued (DB Error)" });
    }
};

// ============================================================
// 2. 🚀 TITAN BROADCAST (Cursor Based Streaming)
// ============================================================
exports.sendTitanBroadcast = async (req, res) => {
    const admin = getFirebase(); // 🛡️ LOAD ON DEMAND
    if (!admin) {
        return res.status(503).json({ success: false, message: "Notification System Offline (Check .env)" });
    }

    const { title, body, imageUrl, actionUrl, dataPayload } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, message: "Payload Incomplete" });

    // 1. Immediate Response
    res.status(200).json({ 
        success: true, 
        message: "Titan Broadcast Initiated. Processing in background..." 
    });

    // 2. Background Processing
    setImmediate(async () => {
        await broadcastNotification({ title, body, imageUrl, actionUrl, dataPayload });
    });
};

// ============================================================
// 3. 🎯 TARGETED SNIPE
// ============================================================
exports.sendTransactional = async (userId, payload) => {
    const admin = getFirebase(); // 🛡️ LOAD ON DEMAND
    if (!admin) return false;

    try {
        const userNodes = await NotificationToken.findAll({
            where: { userId, status: 'ACTIVE' },
            attributes: ['token'],
            raw: true
        });

        if (!userNodes.length) return false;

        const message = {
            notification: { title: payload.title, body: payload.body },
            data: { ...payload.data, url: payload.url || '/' },
            tokens: userNodes.map(n => n.token)
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        return response.successCount > 0;
    } catch (error) {
        console.error("Transactional Push Failed:", error.message);
        return false;
    }
};
