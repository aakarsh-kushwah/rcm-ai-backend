/**
 * @file controllers/paymentController.js
 * @description TITAN FINANCIAL CORE - Optimized for PhonePe/UPI AutoPay (24h Delay)
 * @security Level: MILITARY-GRADE (Signature Verification + Webhooks)
 */

const Razorpay = require("razorpay");
const crypto = require("crypto");
const { User, PaymentLog, sequelize } = require("../models"); 
require('dotenv').config();

// Initialize Razorpay
const instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const getClientIp = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
};

// ============================================================
// 1. CREATE SUBSCRIPTION (Start after 24h, No Immediate Charge)
// ============================================================
const createSubscription = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const userId = req.user.id;
        const ip = getClientIp(req);

        // 1. Lock User Row
        const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
        
        if (!user) {
            await t.rollback();
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.status === 'PREMIUM' && user.autoPayStatus === true) {
            await t.rollback();
            return res.status(409).json({ success: false, message: "Subscription already active." });
        }

        // 2. Customer Logic (Create or Retrieve)
        let customerId = user.razorpayCustomerId;
        if (!customerId) {
            try {
                const customer = await instance.customers.create({
                    name: user.fullName || "Titan User",
                    contact: user.phone || "+919000090000",
                    email: user.email,
                    notes: { internal_id: userId }
                });
                customerId = customer.id;
                user.razorpayCustomerId = customerId;
                await user.save({ transaction: t });
            } catch (err) {
                console.warn("Customer Creation Warning:", err);
            }
        }

        // 3. ⏰ TIME LOGIC: Start 24 Hours Later
        const now = Math.floor(Date.now() / 1000);
        const startAt = now + (24 * 60 * 60); // Current Time + 24 Hours

        // 4. Create Subscription
        const subscription = await instance.subscriptions.create({
            plan_id: process.env.RAZORPAY_PLAN_ID,
            customer_id: customerId,
            total_count: 120, // 10 Years
            quantity: 1,
            customer_notify: 1,
            start_at: startAt, // <--- This delays the ₹29 charge to tomorrow
            
            // ❌ ADDONS REMOVED: No immediate charge. 
            // Razorpay will handle the bank verification (₹0/₹2 refundable) automatically.
            
            notes: { 
                userId: user.id, 
                ip_address: ip,
                system: "Titan_Gen6"
            }
        });

        // 5. Log Setup
        await PaymentLog.create({
            userId: user.id,
            subscriptionId: subscription.id,
            status: 'INITIATED',
            amount: 0.00, // Explicitly 0
            ipAddress: ip,
            method: 'SUBSCRIPTION_SETUP'
        }, { transaction: t });

        await t.commit();

        res.status(200).json({
            success: true,
            subscriptionId: subscription.id,
            key: process.env.RAZORPAY_KEY_ID,
            customer_id: customerId,
            user_name: user.fullName,
            user_email: user.email,
            user_contact: user.phone
        });

    } catch (error) {
        await t.rollback();
        console.error("Create Subscription Error:", error);
        res.status(500).json({ success: false, message: "Server Error during Initialization" });
    }
};

// ============================================================
// 2. VERIFY PAYMENT (Signature Check & Immediate Activation)
// ============================================================
const verifyPayment = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
        const userId = req.user.id;

        // 1. 🛡️ Validate Signature (CRITICAL SECURITY)
        // Even for ₹0 auth, Razorpay sends a payment_id and signature. We must verify it.
        const expectedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_payment_id + "|" + razorpay_subscription_id)
            .digest("hex");

        if (expectedSignature !== razorpay_signature) {
            await t.rollback();
            return res.status(400).json({ success: false, message: "Invalid Payment Signature" });
        }

        // 2. Activate User Immediately
        const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
        
        user.status = 'PREMIUM';
        user.autoPayStatus = true;
        // Billing starts tomorrow, but give access today
        user.nextBillingDate = new Date(Date.now() + 86400000); 
        await user.save({ transaction: t });

        // 3. Log Success
        await PaymentLog.create({
            userId: user.id,
            paymentId: razorpay_payment_id,
            subscriptionId: razorpay_subscription_id,
            status: 'SUCCESS',
            amount: 0.00, // Mandate Auth Amount
            method: 'MANDATE_VERIFIED'
        }, { transaction: t });

        await t.commit();

        console.log(`✅ [FRONTEND VERIFY] User ${userId} activated via Mandate.`);
        res.status(200).json({ success: true, message: "Mandate Verified. Premium Active." });

    } catch (error) {
        await t.rollback();
        console.error("Verification Error:", error);
        res.status(500).json({ success: false, message: "Verification Failed" });
    }
};

// ============================================================
// 3. WEBHOOK (Background Sync & Future Charges)
// ============================================================
const handleWebhook = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    
    // 🛡️ Security: Signature Validation
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== req.headers['x-razorpay-signature']) {
        console.error("⛔ Invalid Webhook Signature");
        return res.status(403).json({ status: 'forbidden' });
    }

    const { event, payload } = req.body;
    console.log(`🔔 Webhook Event: ${event}`);

    try {
        // CASE A: Mandate Successfully Registered (Today)
        if (event === 'subscription.authenticated') {
            const userId = payload.subscription.entity.notes?.userId;
            
            if (userId) {
                const user = await User.findByPk(userId);
                // Idempotency: Only update if not already active
                if (user && user.status !== 'PREMIUM') {
                    user.status = 'PREMIUM';
                    user.autoPayStatus = true;
                    user.nextBillingDate = new Date(Date.now() + 86400000); 
                    await user.save();
                    console.log(`✅ [WEBHOOK AUTH] User ${userId} Activated`);
                }
            }
        } 
        // CASE B: Money Deducted (Tomorrow & Recurring)
        else if (event === 'subscription.charged') {
            const paymentId = payload.payment.entity.id;
            const amount = payload.payment.entity.amount / 100;
            
            // Find User via Notes OR Email
            let user = null;
            const noteUserId = payload.subscription.entity.notes?.userId;
            const email = payload.payment.entity.email;

            if (noteUserId) user = await User.findByPk(noteUserId);
            else if (email) user = await User.findOne({ where: { email } });

            if (user) {
                user.status = 'PREMIUM';
                user.autoPayStatus = true;
                // Extend Date by 1 Month
                user.nextBillingDate = new Date(new Date().setMonth(new Date().getMonth() + 1));
                await user.save();

                // Log Transaction (Avoid Duplicates)
                const exists = await PaymentLog.findOne({ where: { paymentId } });
                if (!exists) {
                    await PaymentLog.create({
                        userId: user.id,
                        paymentId: paymentId,
                        subscriptionId: payload.subscription.entity.id,
                        status: 'WEBHOOK_SUCCESS',
                        amount: amount,
                        method: 'AUTO_DEBIT'
                    });
                }
                console.log(`💰 [RECURRING CHARGE] ₹${amount} Received from ${user.email}`);
            }
        }
        
        res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error("Webhook Logic Error:", e);
        // Return 200 to prevent Razorpay retry loop on internal logic errors
        res.status(200).json({ status: 'error_logged' });
    }
};

// ✅ SECURE EXPORT
module.exports = {
    createSubscription,
    verifyPayment,
    handleWebhook
};