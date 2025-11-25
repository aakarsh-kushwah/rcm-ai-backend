const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../config/db");

// 1. Razorpay इंस्टेंस को .env फ़ाइल से Keys लेकर बनाएँ
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ✅ Step 1: Create subscription
// (यह 'exports.' सिंटैक्स 'routes' फ़ाइल में 'require' के साथ सही काम करता है)
exports.createSubscription = async (req, res) => {
  try {
    const { id: userId, email, fullName: name } = req.user;

    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      return res.status(500).json({
        success: false,
        message: "Razorpay Plan ID not configured.",
      });
    }

    // 7 days trial in seconds
    const trialSeconds = 7 * 24 * 60 * 60;

    // CREATE SUBSCRIPTION with trial
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: null,              // unlimited months
      trial_period: trialSeconds,     // 7-day trial
      notes: { userId, email, name },
    });

    // SAVE subscription ID in user table
    const user = await db.User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    user.razorpayCustomerId = subscription.id;
    await user.save();

    return res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      key: process.env.RAZORPAY_KEY_ID,
    });

  } catch (err) {
    console.error("Subscription creation error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to create subscription.",
    });
  }
};


// ✅ Step 2: Verify payment
exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment verification data.",
      });
    }

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed.",
      });
    }

    await db.User.update(
      { status: "active", autoPayStatus: true },
      { where: { razorpayCustomerId: razorpay_subscription_id } }
    );

    return res.status(200).json({
      success: true,
      message: "Payment verified successfully!",
    });

  } catch (error) {
    console.error("Payment verification error:", error);
    return res.status(500).json({
      success: false,
      message: "Error verifying payment.",
    });
  }
};


