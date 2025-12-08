const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../config/db");

// 1. Razorpay Instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ✅ Step 1: Create subscription
exports.createSubscription = async (req, res) => {
  try {
    const { id: userId, email, fullName: name } = req.user; 

    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      return res.status(500).json({ success: false, message: "Razorpay Plan ID not configured." });
    }

    // ---------------------------------------------------------
    // 🔥 UPDATED LOGIC: Calculate 1 Day from Now (for Testing)
    // ---------------------------------------------------------
    const date = new Date();
    
    // 👇 CHANGED FROM 7 TO 1
    date.setDate(date.getDate() + 1); 
    
    // Razorpay requires the date in "Unix Timestamp" format (seconds, not milliseconds)
    const startAtTimestamp = Math.floor(date.getTime() / 1000); 
    // ---------------------------------------------------------

    // ✅ Create a subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 360,
      quantity: 1,
      start_at: startAtTimestamp, // Will now start exactly 24 hours from now
      customer_notify: 1,
      notes: { userId, email, name }, 
    });

    // ✅ Save subscription ID to user table
    const user = await db.User.findByPk(userId);
    if (user) {
        user.razorpayCustomerId = subscription.id; 
        await user.save();
    } else {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      key: process.env.RAZORPAY_KEY_ID, 
    });
  } catch (err) {
    console.error("Subscription creation error:", err);
    res.status(500).json({ success: false, message: "Failed to create subscription." });
  }
};


// ✅ Step 2: Verify payment (ALREADY CORRECT)
// Your verification logic is correct for Subscriptions. 
// Just ensuring the signature string is 'payment_id|subscription_id'
exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment verification data." });
    }

    // ✅ Verify Signature
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`) // Correct format for Subscriptions
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Payment verification failed." });
    }

    // ✅ Mark user as active
    // Since payment is verified (Auth transaction successful), we enable AutoPay status
    await db.User.update(
      { status: "active", autoPayStatus: true },
      { where: { razorpayCustomerId: razorpay_subscription_id } }
    );

    res.status(200).json({ success: true, message: "Payment verified successfully!" });
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ success: false, message: "Error verifying payment." });
  }
};