/**
 * @file controllers/paymentController.js
 * @description TITAN FINANCIAL CORE - Fixed Imports
 */

const Razorpay = require("razorpay");
const crypto = require("crypto");
const { User, PaymentLog, sequelize } = require("../models"); 
require('dotenv').config();

const instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const getClientIp = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
};

// ---------------------------------------------------------
// 1. CREATE SUBSCRIPTION (Delayed 24h Charge)
// ---------------------------------------------------------
const createSubscription = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const userId = req.user.id;
        const ip = getClientIp(req);

        const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
        
        if (!user) {
            await t.rollback();
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Customer Logic
        let customerId = user.razorpayCustomerId;
        if (!customerId) {
            try {
                const customer = await instance.customers.create({
                    name: user.fullName || "User",
                    contact: user.phone || "+919000090000",
                    email: user.email,
                    notes: { internal_id: userId }
                });
                customerId = customer.id;
                user.razorpayCustomerId = customerId;
                await user.save({ transaction: t });
            } catch (err) {
                console.warn("Customer Create Error (Non-Fatal):", err);
            }
        }

        // Logic: Start plan 24 hours later
        const now = Math.floor(Date.now() / 1000);
        const startAt = now + (24 * 60 * 60); 

        const subscription = await instance.subscriptions.create({
            plan_id: process.env.RAZORPAY_PLAN_ID,
            customer_id: customerId,
            total_count: 120, 
            quantity: 1,
            customer_notify: 1,
            start_at: startAt, // Charge starts tomorrow
            addons: [
                {
                    item: {
                        name: "Verification Fee",
                        amount: 500, // ₹5.00 Immediate
                        currency: "INR"
                    }
                }
            ],
            notes: { userId: user.id, ip_address: ip }
        });

        await PaymentLog.create({
            userId: user.id,
            subscriptionId: subscription.id,
            status: 'INITIATED',
            amount: 5.00,
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
        console.error("Create Sub Error:", error);
        res.status(500).json({ success: false, message: "Subscription Init Failed" });
    }
};

// ---------------------------------------------------------
// 2. VERIFY PAYMENT (Frontend Handler)
// ---------------------------------------------------------
const verifyPayment = async (req, res) => {
    // Frontend just needs a positive response to proceed.
    // The real work is done by the Webhook.
    res.status(200).json({ success: true, message: "Verification processing..." });
};

// ---------------------------------------------------------
// 3. WEBHOOK (Backend Handler)
// ---------------------------------------------------------
const handleWebhook = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    
    // Validate Signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== req.headers['x-razorpay-signature']) {
        return res.status(403).json({ status: 'forbidden' });
    }

    const { event, payload } = req.body;
    console.log(`🔔 Webhook Event: ${event}`);

    try {
        if (event === 'subscription.authenticated') {
            const userId = payload.subscription.entity.notes?.userId;
            if (userId) {
                const user = await User.findByPk(userId);
                if (user) {
                    user.status = 'PREMIUM';
                    user.autoPayStatus = true;
                    user.nextBillingDate = new Date(Date.now() + 86400000); // 24h later
                    await user.save();
                    console.log(`✅ User ${userId} Activated (Auth)`);
                }
            }
        } 
        else if (event === 'payment.authorized' || event === 'subscription.charged') {
            const userId = payload.payment.entity.notes?.userId || payload.subscription.entity.notes?.userId;
            const email = payload.payment.entity.email;
            
            let user = null;
            if (userId) user = await User.findByPk(userId);
            else if (email) user = await User.findOne({ where: { email } });

            if (user) {
                user.status = 'PREMIUM';
                user.autoPayStatus = true;
                await user.save();

                const payId = payload.payment.entity.id;
                const exists = await PaymentLog.findOne({ where: { paymentId: payId } });
                if (!exists) {
                    await PaymentLog.create({
                        userId: user.id,
                        paymentId: payId,
                        status: 'WEBHOOK_SUCCESS',
                        amount: (payload.payment.entity.amount / 100),
                        method: 'AUTO_DEBIT'
                    });
                }
                console.log(`💰 Money Received from ${user.email}`);
            }
        }
        
        res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error("Webhook Logic Error:", e);
        res.status(200).json({ status: 'error_logged' });
    }
};

// ✅ SECURE EXPORT (This fixes the "Undefined" error)
module.exports = {
    createSubscription,
    verifyPayment,
    handleWebhook
};