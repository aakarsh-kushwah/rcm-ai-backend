/**
 * @file src/controllers/paymentController.js
 * @description Titan Financial Core (Simplified & Robust)
 */

const Razorpay = require("razorpay");
const crypto = require("crypto");
const { User, PaymentLog, sequelize } = require("../models");
require('dotenv').config();

// 🛡️ RAZORPAY INSTANCE (With Space Protection)
const instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID ? process.env.RAZORPAY_KEY_ID.trim() : "",
    key_secret: process.env.RAZORPAY_KEY_SECRET ? process.env.RAZORPAY_KEY_SECRET.trim() : "",
});

const getClientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

// ============================================================
// 1. CREATE SUBSCRIPTION (Starts Tomorrow)
// ============================================================
exports.createSubscription = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const userId = req.user.id;
        const ip = getClientIp(req);

        const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!user) { await t.rollback(); return res.status(404).json({ success: false, message: "User not found." }); }

        // Already Active Check
        if ((user.status === 'active' || user.status === 'premium') && user.autoPayStatus === true) {
            await t.rollback();
            return res.status(409).json({ success: false, message: "Already active." });
        }

        // Customer ID Logic
        let customerId = user.razorpayCustomerId;
        if (!customerId) {
            try {
                const customer = await instance.customers.create({
                    name: user.fullName,
                    contact: user.phone,
                    email: user.email,
                    notes: { internal_id: userId }
                });
                customerId = customer.id;
                user.razorpayCustomerId = customerId;
                await user.save({ transaction: t });
            } catch (err) { console.warn("Customer create error (ignorable):", err.message); }
        }

        // 📅 START AT TOMORROW LOGIC
        // Razorpay ko batayenge ki subscription kal se shuru kare.
        // Aaj user sirf Auth Charge (₹5) dega jo wapas aa jayega.
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(tomorrow.getHours() + 1); // Thoda buffer time
        const startAtUnix = Math.floor(tomorrow.getTime() / 1000);

        const planId = process.env.RAZORPAY_PLAN_ID ? process.env.RAZORPAY_PLAN_ID.trim() : "";
        
        const subscription = await instance.subscriptions.create({
            plan_id: planId,
            customer_id: customerId,
            total_count: 120, 
            quantity: 1,
            customer_notify: 1,
            start_at: startAtUnix,
            notes: { userId: user.id, ip_address: ip }
        });

        await PaymentLog.create({
            userId: user.id,
            subscriptionId: subscription.id,
            status: 'INITIATED',
            amount: 0, 
            ipAddress: ip,
            method: 'SUBSCRIPTION_SETUP'
        }, { transaction: t });

        await t.commit();

        res.status(200).json({
            success: true,
            subscriptionId: subscription.id,
            key: process.env.RAZORPAY_KEY_ID ? process.env.RAZORPAY_KEY_ID.trim() : "",
            customer_id: customerId
        });

    } catch (error) {
        await t.rollback();
        console.error("🔥 Create Sub Error:", error);
        res.status(500).json({ success: false, message: "Failed to initiate." });
    }
};

// ============================================================
// 2. VERIFY PAYMENT (Immediate Activation)
// ============================================================
exports.verifyPayment = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
        const userId = req.user.id;

        const generated_signature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET ? process.env.RAZORPAY_KEY_SECRET.trim() : "")
            .update(razorpay_payment_id + '|' + razorpay_subscription_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            await t.rollback();
            return res.status(400).json({ success: false, message: "Invalid Signature" });
        }

        const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
        
        // ✅ Status ko 'premium' kar do turant
        user.status = 'premium';
        user.autoPayStatus = true;
        // Date update optional hai kyunki ab hum status-based check kar rahe hain
        user.nextBillingDate = new Date(new Date().setMonth(new Date().getMonth() + 1)); 
        
        await user.save({ transaction: t });

        await PaymentLog.create({
            userId,
            paymentId: razorpay_payment_id,
            subscriptionId: razorpay_subscription_id,
            status: 'SUCCESS',
            amount: 249.00,
            method: 'VERIFIED_SETUP'
        }, { transaction: t });

        await t.commit();
        res.status(200).json({ success: true, message: "Activated!" });

    } catch (error) {
        await t.rollback();
        console.error("🔥 Verify Error:", error);
        res.status(500).json({ success: false, message: "Verification Failed" });
    }
};

// ============================================================
// 3. WEBHOOK (The Master Controller)
// ============================================================
exports.handleWebhook = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    
    // Validation
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');
    if (digest !== req.headers['x-razorpay-signature']) return res.status(403).json({ status: 'forbidden' });

    const { event, payload } = req.body;
    console.log(`🔔 Webhook: ${event}`);

    try {
        // Email ya Customer ID se user dhundo
        // (Preferred: Customer ID se dhundo agar available hai, warna email)
        const email = payload.payment?.entity?.email || payload.subscription?.entity?.notes?.email;
        const rzpCustId = payload.subscription?.entity?.customer_id;

        let user = null;
        if (rzpCustId) user = await User.findOne({ where: { razorpayCustomerId: rzpCustId } });
        if (!user && email) user = await User.findOne({ where: { email } });

        if (user) {
            // ✅ CASE 1: Payment Success (Auto-Debit)
            if (event === 'subscription.charged') {
                console.log(`✅ Charged: ${user.email}. Extending Access.`);
                user.status = 'premium';
                user.autoPayStatus = true;
                // Next billing date update kar sakte hain record ke liye
                user.nextBillingDate = new Date(payload.subscription.entity.current_end * 1000); 
                await user.save();
                
                // Log create karo
                await PaymentLog.create({
                    userId: user.id,
                    paymentId: payload.payment.entity.id,
                    status: 'WEBHOOK_SUCCESS',
                    amount: payload.payment.entity.amount / 100,
                    method: 'AUTO_DEBIT'
                });
            }
            
            // ❌ CASE 2: Payment Failed / Cancelled / Halted
            // Agar Razorpay payment nahi le paya, ya user ne cancel kiya -> Pending kar do
            else if (
                event === 'subscription.halted' || 
                event === 'subscription.cancelled' || 
                event === 'subscription.paused' ||
                event === 'payment.failed' // Optional: Agar payment fail hui to turant access rokna hai ya retry ka wait karna hai? Usually halted par rokte hain.
            ) {
                console.log(`⛔ Stopped: ${user.email}. Revoking Access.`);
                user.status = 'pending'; // Access Blocked
                user.autoPayStatus = false;
                await user.save();
            }
        }

        res.json({ status: 'ok' });

    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(200).json({ status: 'error_logged' }); // 200 hi bhejo taaki Razorpay retry na kare
    }
};