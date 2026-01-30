const Razorpay = require("razorpay");
const crypto = require("crypto");
const { User, PaymentLog, sequelize } = require("../models"); 
require('dotenv').config();

const instance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ============================================================
// 1. CREATE SUBSCRIPTION (Delayed Charge Logic)
// ============================================================
exports.createSubscription = async (req, res) => {
    const t = await sequelize.transaction();

    try {
        const userId = req.user.id;
        const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });

        // 1. Customer Creation (Standard)
        let customerId = user.razorpayCustomerId;
        if (!customerId) {
            const customer = await instance.customers.create({
                name: user.fullName || "Titan User",
                contact: user.phone || "+919000090000",
                email: user.email,
                notes: { internal_id: userId }
            });
            customerId = customer.id;
            user.razorpayCustomerId = customerId;
            await user.save({ transaction: t });
        }

        // 2. ⏰ TIME TRAVEL LOGIC (24 Hours Later)
        const now = Math.floor(Date.now() / 1000);
        const twentyFourHoursLater = now + (24 * 60 * 60); 

        // 3. CREATE SUBSCRIPTION
        const subscription = await instance.subscriptions.create({
            plan_id: process.env.RAZORPAY_PLAN_ID, // Ensure this plan is for ₹29
            customer_id: customerId,
            total_count: 120, 
            quantity: 1,
            customer_notify: 1,
            
            // ✅ THE MAGIC SETTING
            // This tells Razorpay: "Register mandate NOW, but charge money TOMORROW"
            start_at: twentyFourHoursLater,
            
            // ❌ NO ADDONS: We removed the immediate charge. 
            // Razorpay/PhonePe will handle the small auth amount (if any) automatically.
            
            notes: { 
                userId: user.id, 
                system: "Titan_Gen6_Delayed" 
            }
        });

        // Log the "Setup" attempt
        await PaymentLog.create({
            userId: user.id,
            subscriptionId: subscription.id,
            status: 'MANDATE_SETUP_INITIATED',
            amount: 0.00, // No charge yet
            method: 'SUBSCRIPTION_SETUP'
        }, { transaction: t });

        await t.commit();

        res.status(200).json({
            success: true,
            subscriptionId: subscription.id,
            key: process.env.RAZORPAY_KEY_ID,
            customer_id: customerId
        });

    } catch (error) {
        await t.rollback();
        console.error("Subscription Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};

// ============================================================
// 2. 🧠 SMART WEBHOOK (Handles Authentication & Charge)
// ============================================================
exports.handleWebhook = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // 1. Verify Signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== req.headers['x-razorpay-signature']) {
        return res.status(403).json({ status: 'forbidden' });
    }

    const { event, payload } = req.body;
    console.log(`🔔 Event: ${event}`);

    try {
        // ✅ CASE 1: MANDATE AUTHENTICATED (Happens TODAY)
        // This confirms the user is verified. ACTIVATE THEM NOW.
        if (event === 'subscription.authenticated') {
            const userId = payload.subscription.entity.notes?.userId;
            
            if (userId) {
                const user = await User.findByPk(userId);
                if (user) {
                    user.status = 'PREMIUM';
                    user.autoPayStatus = true;
                    // Billing starts tomorrow, but we give access today
                    user.nextBillingDate = new Date(Date.now() + 86400000); 
                    await user.save();
                    
                    console.log(`✅ [MANDATE VERIFIED] User ${userId} Activated (Charge pending tomorrow)`);
                }
            }
        }

        // ✅ CASE 2: MONEY DEDUCTED (Happens TOMORROW & Monthly)
        // This confirms the actual ₹29 deduction.
        else if (event === 'subscription.charged') {
            const paymentId = payload.payment.entity.id;
            const amount = payload.payment.entity.amount / 100; // Convert paise to Rupees
            const subNotes = payload.subscription.entity.notes; // Best source for user ID
            
            // Find User
            let user = null;
            if (subNotes?.userId) {
                user = await User.findByPk(subNotes.userId);
            } else {
                // Fallback to email
                const email = payload.payment.entity.email;
                user = await User.findOne({ where: { email } });
            }

            if (user) {
                // Extend their validity
                user.status = 'PREMIUM';
                user.autoPayStatus = true;
                user.nextBillingDate = new Date(new Date().setMonth(new Date().getMonth() + 1));
                await user.save();

                // 📝 Log the ₹29 Transaction
                // Check for duplicates first (Idempotency)
                const exists = await PaymentLog.findOne({ where: { paymentId } });
                if (!exists) {
                    await PaymentLog.create({
                        userId: user.id,
                        paymentId: paymentId,
                        subscriptionId: payload.subscription.entity.id,
                        status: 'SUCCESS',
                        amount: amount,
                        method: 'AUTO_DEBIT'
                    });
                }
                console.log(`💰 [₹${amount} RECEIVED] Subscription Charged for User ${user.id}`);
            }
        }

        // ✅ CASE 3: FAILURE (Insufficient Balance / Cancelled)
        else if (event === 'subscription.halted' || event === 'subscription.cancelled') {
             // Deactivate user logic here...
        }

        res.status(200).json({ status: 'ok' });

    } catch (error) {
        console.error("Webhook Error:", error);
        // Return 200 anyway to prevent Razorpay from retrying endlessly
        res.status(200).json({ status: 'error_logged' });
    }
};