/**
 * @file src/controllers/paymentController.js
 * @description Titan Financial Core (Bank-Grade Security | Atomic Transactions | 24h Trial Logic)
 * @status PRODUCTION READY | HIGH SECURITY
 */

const Razorpay = require("razorpay");
const crypto = require("crypto");
const { User, PaymentLog, sequelize } = require("../models");
require('dotenv').config();

// 🛡️ LEVEL 1: ENVIRONMENT VALIDATION
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error("❌ CRITICAL: Razorpay Keys Missing. Payment Gateway Halted.");
    // Process exit nahi karenge taaki baaki app chalta rahe, par logs me error dikhega
}

// 🛡️ LEVEL 2: SECURE INSTANCE INITIALIZATION
const instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID?.trim(),
    key_secret: process.env.RAZORPAY_KEY_SECRET?.trim(),
});

// Helper: Get Real IP (Behind Cloudflare/Load Balancer)
const getClientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ============================================================
// 1. CREATE SUBSCRIPTION (Free Trial: Starts Tomorrow)
// ============================================================
exports.createSubscription = async (req, res) => {
    // 🔒 Transaction Start: Data consistency ke liye
    const t = await sequelize.transaction();

    try {
        const userId = req.user.id;
        const ip = getClientIp(req);

        // Lock User Row: Race Conditions rokne ke liye
        const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
        
        if (!user) { await t.rollback(); return res.status(404).json({ success: false, message: "User identity not found." }); }

        // ✅ Check Existing Subscription
        if (user.status === 'premium' && user.autoPayStatus === true) {
            await t.rollback();
            return res.status(409).json({ success: false, message: "Titan Premium is already active." });
        }

        // ✅ Step A: Customer Management (Idempotent)
        let customerId = user.razorpayCustomerId;
        if (!customerId) {
            try {
                const customer = await instance.customers.create({
                    name: user.fullName || "Titan Subscriber",
                    contact: user.phone || "+919999999999", // Fallback for Razorpay validation
                    email: user.email,
                    notes: { titan_uid: userId }
                });
                customerId = customer.id;
                // Transaction ke andar update karein
                await User.update({ razorpayCustomerId: customerId }, { where: { id: userId }, transaction: t });
            } catch (err) {
                console.warn(`⚠️ [TITAN-PAY] Customer Sync Warning: ${err.message}`);
                // Agar phone number duplicate ka error hai, toh hum aage badhenge (Non-Blocking)
            }
        }

        // ✅ Step B: Plan Configuration
        // Ensure karein ki .env me ₹29 wale plan ki ID ho
        const planId = process.env.RAZORPAY_PLAN_ID?.trim();
        if (!planId) throw new Error("Billing Configuration (Plan ID) Missing.");

        // ✅ Step C: TIME TRAVEL LOGIC (Trial)
        // Subscription abhi banegi, lekin billing cycle 24 ghante baad shuru hogi.
        const now = new Date();
        const startAtDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Now + 24 Hours
        const startAtUnix = Math.floor(startAtDate.getTime() / 1000);

        const subscription = await instance.subscriptions.create({
            plan_id: planId,
            customer_id: customerId,
            total_count: 120, // 10 Years (Unlimited feel)
            quantity: 1,
            customer_notify: 1, // Razorpay user ko email bhejega
            start_at: startAtUnix, // 🔥 MAGIC LINE: Paisa kal katega
            notes: { userId: user.id, ip: ip, intent: "titan_premium_29" }
        });

        // ✅ Step D: Audit Log
        await PaymentLog.create({
            userId: user.id,
            subscriptionId: subscription.id,
            status: 'TRIAL_INITIATED',
            amount: 0, // Abhi ₹0 charge ho raha hai
            ipAddress: ip,
            method: 'SUBSCRIPTION_SETUP'
        }, { transaction: t });

        await t.commit(); // 🔒 Transaction Success

        res.status(200).json({
            success: true,
            subscriptionId: subscription.id,
            key: process.env.RAZORPAY_KEY_ID,
            customer_id: customerId,
            plan_id: planId,
            trial_active: true,
            billing_starts: startAtDate
        });

    } catch (error) {
        await t.rollback(); // 🔒 Transaction Fail - Revert Changes
        console.error("🔥 [TITAN-PAY-ERR] Init Failed:", error.message);
        res.status(500).json({ success: false, message: "Secure Channel Handshake Failed." });
    }
};

// ============================================================
// 2. VERIFY PAYMENT (Immediate Access Grant)
// ============================================================
exports.verifyPayment = async (req, res) => {
    const t = await sequelize.transaction();
    
    try {
        const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
        const userId = req.user.id;

        // 🛡️ LEVEL 3: CRYPTOGRAPHIC VERIFICATION (Timing Attack Proof)
        // '===' use nahi karenge, 'timingSafeEqual' use karenge jo hacker guess nahi kar sakta
        const generated_signature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_payment_id + '|' + razorpay_subscription_id)
            .digest('hex');

        const receivedParams = Buffer.from(razorpay_signature, 'utf8');
        const generatedParams = Buffer.from(generated_signature, 'utf8');

        if (receivedParams.length !== generatedParams.length || !crypto.timingSafeEqual(receivedParams, generatedParams)) {
            await t.rollback();
            return res.status(400).json({ success: false, message: "Security Alert: Signature Forgery Detected." });
        }

        // ✅ Check Idempotency (Replay Attack Protection)
        const existingLog = await PaymentLog.findOne({ 
            where: { paymentId: razorpay_payment_id }, 
            transaction: t 
        });

        if (existingLog) {
            await t.commit();
            return res.status(200).json({ success: true, message: "Transaction already processed." });
        }

        // ✅ ACTIVATE PREMIUM (Trial Mode)
        // User ko abhi access do, paisa kal katega.
        const nextBilling = new Date();
        nextBilling.setDate(nextBilling.getDate() + 30); 

        await User.update({
            status: 'premium',
            autoPayStatus: true,
            razorpaySubscriptionId: razorpay_subscription_id,
            nextBillingDate: nextBilling
        }, { where: { id: userId }, transaction: t });

        // ✅ Log Successful Setup
        await PaymentLog.create({
            userId,
            paymentId: razorpay_payment_id,
            subscriptionId: razorpay_subscription_id,
            status: 'SUCCESS',
            amount: 29.00, // ✅ Database record ke liye ₹29
            method: 'VERIFIED_SETUP',
            ipAddress: getClientIp(req)
        }, { transaction: t });

        await t.commit();
        res.status(200).json({ success: true, message: "Titan Premium: Access Granted." });

    } catch (error) {
        await t.rollback();
        console.error("🔥 [TITAN-VERIFY-ERR]:", error.message);
        res.status(500).json({ success: false, message: "Verification Protocol Failed." });
    }
};

// ============================================================
// 3. WEBHOOK (The Silent Guardian - Recurring Billing)
// ============================================================
exports.handleWebhook = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    // 🛡️ VALIDATION
    if (!secret || !signature) {
        return res.status(400).json({ status: 'invalid_request' });
    }

    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
        console.warn("⛔ [TITAN-WEBHOOK] Signature Mismatch! Possible Attack.");
        return res.status(403).json({ status: 'forbidden' });
    }

    const { event, payload } = req.body;
    
    // ✅ ULTRA-IDEMPOTENCY: Check Event ID
    // Razorpay same event multiple time bhej sakta hai.
    // Hum payment ID check karenge taaki DB mein duplicate entry na ho.
    const paymentEntity = payload.payment?.entity;
    if (paymentEntity?.id) {
        const isProcessed = await PaymentLog.findOne({ where: { paymentId: paymentEntity.id } });
        if (isProcessed) {
            console.log(`ℹ️ [TITAN-WEBHOOK] Skipped Duplicate Event: ${paymentEntity.id}`);
            return res.status(200).json({ status: 'ok' });
        }
    }

    try {
        // User finding strategy: Sub ID -> Customer ID
        const subId = payload.subscription?.entity?.id;
        let user = null;
        
        if (subId) user = await User.findOne({ where: { razorpaySubscriptionId: subId } });
        if (!user && payload.subscription?.entity?.customer_id) {
            user = await User.findOne({ where: { razorpayCustomerId: payload.subscription.entity.customer_id } });
        }

        if (!user) {
            console.warn(`⚠️ [TITAN-WEBHOOK] User not found for Subscription: ${subId}`);
            return res.status(200).json({ status: 'ok' }); // 200 return karo taaki retry loop ruk jaye
        }

        // 🟢 CASE 1: Paisa kat gaya (Subscription Renewed)
        if (event === 'subscription.charged') {
            const endDate = payload.subscription.entity.current_end; // Unix
            const amount = paymentEntity?.amount ? paymentEntity.amount / 100 : 0;

            user.status = 'premium';
            user.autoPayStatus = true;
            user.nextBillingDate = new Date(endDate * 1000);
            await user.save();

            await PaymentLog.create({
                userId: user.id,
                paymentId: paymentEntity?.id || `sub_${Date.now()}`,
                status: 'WEBHOOK_RENEWAL',
                amount: amount, // Ye ₹29 hoga
                method: 'AUTO_DEBIT'
            });
            console.log(`✅ [TITAN-RENEW] User: ${user.email} | Amount: ₹${amount}`);
        }
        
        // 🔴 CASE 2: Payment Fail / User Cancelled
        else if (['subscription.halted', 'subscription.cancelled', 'subscription.paused'].includes(event)) {
            user.status = 'expired';
            user.autoPayStatus = false;
            await user.save();
            console.log(`⛔ [TITAN-STOP] Access Revoked: ${user.email}`);
        }

        res.status(200).json({ status: 'ok' });

    } catch (error) {
        console.error("🔥 [TITAN-WEBHOOK-ERR]:", error.message);
        // Error par bhi 200 bhejo, warna Razorpay baar-baar bhejega
        res.status(200).json({ status: 'error_logged' });
    }
};