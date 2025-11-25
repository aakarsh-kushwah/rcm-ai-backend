const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../config/db");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// -----------------------------------------------------
// STEP 1 : Create Subscription with 7-Day Trial
// -----------------------------------------------------

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

    // 🔥 Subscription with Trial & Max Duration
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 120,            // 120 months (10 years max)
      customer_notify: 1,
      trial_period: 604800,        // 7 days trial (in seconds)
      notes: { userId, email, name }
    });

    // Save subscription ID
    const user = await db.User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
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
      message: "Failed to create subscription."
    });
  }
};

// -----------------------------------------------------
// STEP 2 : Verify Payment + Auto Refund ₹1
// -----------------------------------------------------

exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment data."
      });
    }

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed."
      });
    }

    // -----------------------------------------------------
    // 🔥 Auto Refund ₹1 authentication payment
    // -----------------------------------------------------
    await razorpay.payments.refund(razorpay_payment_id, {
      amount: 100 // ₹1 = 100 paise
    });

    // -----------------------------------------------------
    // Mark user active + AutoPay On
    // -----------------------------------------------------
    await db.User.update(
      { status: "active", autoPayStatus: true },
      { where: { razorpayCustomerId: razorpay_subscription_id } }
    );

    return res.status(200).json({
      success: true,
      message: "Payment verified & ₹1 refunded!"
    });

  } catch (error) {
    console.error("Payment verification error:", error);
    return res.status(500).json({
      success: false,
      message: "Error verifying payment."
    });
  }
};
