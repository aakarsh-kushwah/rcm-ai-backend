// backend/controllers/paymentController.js
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../config/db");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ✅ Step 1: Create subscription
exports.createSubscription = async (req, res) => {
  try {
    const { userId, email, name } = req.body;

    // 🛑 Validate inputs
    if (!userId || !email) {
      return res
        .status(400)
        .json({ success: false, message: "User ID and email are required." });
    }

    // ✅ Use the plan ID from .env (created manually or programmatically)
    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      return res
        .status(500)
        .json({ success: false, message: "Razorpay Plan ID not configured." });
    }

    // ✅ Create a subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12, // 12 months
      customer_notify: 1,
      notes: { userId, email, name },
    });

    // ✅ Save subscription ID to user table
    await db.User.update(
      { razorpayCustomerId: subscription.id },
      { where: { id: userId } }
    );

    res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Subscription creation error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to create subscription." });
  }
};

// ✅ Step 2: Verify payment
exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } =
      req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, message: "Missing payment verification data." });
    }

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, message: "Payment verification failed." });
    }

    // ✅ Mark user as active and enable autopay
    await db.User.update(
      { status: "active", autoPayStatus: true },
      { where: { razorpayCustomerId: razorpay_subscription_id } }
    );

    res
      .status(200)
      .json({ success: true, message: "Payment verified successfully!" });
  } catch (error) {
    console.error("Payment verification error:", error);
    res
      .status(500)
      .json({ success: false, message: "Error verifying payment." });
  }
};
