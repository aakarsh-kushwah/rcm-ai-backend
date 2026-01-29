const Razorpay = require("razorpay");
const crypto = require("crypto");

// ✅ FIX: Correct import from models
const db = require("../models");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.createSubscription = async (req, res) => {
  try {
    // 1. Get User ID from Token
    const { id: userId } = req.user;

    // 2. FETCH FRESH DATA
    const user = await db.User.findByPk(userId);

    if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    const { email, fullName, phone } = user;
    const userPhone = phone || "9000090000"; 

    // 🔍 DEBUG: Check Plan ID
    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      console.error("❌ CRITICAL: RAZORPAY_PLAN_ID is missing in .env file");
      return res.status(500).json({ success: false, message: "Server Configuration Error: Plan ID missing." });
    }
    
    // 3. Customer Logic
    let customerId = user.razorpayCustomerId;

    if (!customerId || !customerId.startsWith("cust_")) {
        console.log(`ℹ️ Creating Razorpay Customer for: ${email}`);
        try {
            const customer = await razorpay.customers.create({
                name: fullName,
                contact: userPhone,
                email: email,
                fail_existing: 0, 
            });
            customerId = customer.id;
            
            // Update DB
            user.razorpayCustomerId = customerId;
            await user.save();
        } catch (error) {
            // Handle "Customer already exists" gracefully
            if (error.statusCode === 400 && error.error && error.error.description.includes('already exists')) {
                console.log("⚠️ Customer exists, fetching from Razorpay...");
                const existing = await razorpay.customers.all({ email: email, count: 1 });
                if (existing.items.length > 0) {
                    customerId = existing.items[0].id;
                    user.razorpayCustomerId = customerId;
                    await user.save();
                } else {
                    throw new Error("Customer exists on Razorpay but could not be fetched.");
                }
            } else {
                console.error("❌ Razorpay Customer Creation Failed:", error);
                throw error;
            }
        }
    }

    // 4. Create Subscription
    // ⚠️ IMPORTANT: Razorpay 'start_at' must be in the future. 
    // If you want the subscription to start IMMEDIATELY (auto-charge now), 
    // DO NOT SEND 'start_at'.
    
    // Current logic: Start after 24 hours.
    // If you want immediate billing, comment out 'start_at' in the options below.
    const date = new Date();
    date.setDate(date.getDate() + 1); 
    const startAtTimestamp = Math.floor(date.getTime() / 1000); 

    const subOptions = {
      plan_id: planId,
      customer_id: customerId,
      total_count: 360, // Billing cycles
      quantity: 1,
      start_at: startAtTimestamp, // Remove this line for immediate payment!
      customer_notify: 1,
      notes: { userId: String(userId), email, name: fullName }, // Ensure values are strings
    };

    console.log("🚀 Sending Subscription Request to Razorpay:", JSON.stringify(subOptions, null, 2));

    try {
        const subscription = await razorpay.subscriptions.create(subOptions);
        
        console.log("✅ Subscription Created:", subscription.id);

        res.status(200).json({
            success: true,
            subscriptionId: subscription.id,
            key: process.env.RAZORPAY_KEY_ID,
            user_name: fullName,
            user_email: email,
            user_contact: userPhone 
        });
    } catch (razorpayError) {
        // 🛑 This block catches the specific SDK crash
        console.error("🔥 RAZORPAY API ERROR RAW:", razorpayError);
        
        // Return a clean error to frontend
        return res.status(400).json({ 
            success: false, 
            message: "Razorpay refused the request. Check Server Logs.",
            details: razorpayError.error ? razorpayError.error.description : razorpayError.message
        });
    }

  } catch (err) {
    console.error("🔥 General Subscription Error:", err);
    res.status(500).json({ success: false, message: "Failed to create subscription." });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment data." });
    }

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`) 
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Signature verification failed." });
    }

    // Activate User
    if(req.user && req.user.id) {
         await db.User.update(
          { status: "active", autoPayStatus: true },
          { where: { id: req.user.id } }
        );
    }

    res.status(200).json({ success: true, message: "Payment verified successfully!" });
  } catch (error) {
    console.error("Verify Error:", error);
    res.status(500).json({ success: false, message: "Server error verifying payment." });
  }
};