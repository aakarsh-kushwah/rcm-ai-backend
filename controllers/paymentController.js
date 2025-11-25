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
    // req.user 'isAuthenticated' मिडलवेयर से आ रहा है
    const { id: userId, email, fullName: name } = req.user; 

    // ✅ Use the plan ID from .env
    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      return res
        .status(500)
        .json({ success: false, message: "Razorpay Plan ID not configured." });
    }

    // ✅ Create a subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12, // 12 महीने
      customer_notify: 1,
      notes: { userId, email, name }, // ट्रैकिंग के लिए नोट्स
    });

    // ✅ Save subscription ID to user table
    // (findByPk ज़्यादा सुरक्षित है, ताकि हम सही यूज़र को अपडेट करें)
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
      key: process.env.RAZORPAY_KEY_ID, // Key को फ्रंटएंड पर भेजें
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

    // ✅ सुरक्षित रूप से सिग्नेचर को वेरिफ़ाई करें
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, message: "Payment verification failed." });
    }

    // ✅ यूज़र को 'active' और 'autopay' के लिए मार्क करें
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

