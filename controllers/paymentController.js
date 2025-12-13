const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../config/db");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.createSubscription = async (req, res) => {
  try {
    // 1. Get User ID from Token
    const { id: userId } = req.user;

    // 2. FETCH FRESH DATA FROM DB (Best Practice)
    // Token ka data purana ho sakta hai, isliye DB se nikalo
    const user = await db.User.findByPk(userId);

    if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
    }

    const { email, fullName, phone } = user; // Ab ye DB se aa raha hai

    // Agar phone abhi bhi nahi hai, tabhi dummy use karo (aur log karo taaki pata chale)
    if (!phone) console.warn(`⚠️ User ${userId} has no phone number! Using dummy.`);
    const userPhone = phone || "9000090000"; 

    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      return res.status(500).json({ success: false, message: "Plan ID missing." });
    }

    // 3. Customer Logic (Same as before with fail-safe)
    let customerId = user.razorpayCustomerId;

    if (!customerId || !customerId.startsWith("cust_")) {
        console.log("Creating Razorpay Customer for:", email);
        try {
            const customer = await razorpay.customers.create({
                name: fullName,
                contact: userPhone,
                email: email,
                fail_existing: 0, 
            });
            customerId = customer.id;
        } catch (error) {
            if (error.statusCode === 400 && error.error.description.includes('already exists')) {
                const existing = await razorpay.customers.all({ email: email, count: 1 });
                if (existing.items.length > 0) customerId = existing.items[0].id;
                else throw new Error("Customer exists but fetch failed.");
            } else throw error;
        }
        user.razorpayCustomerId = customerId;
        await user.save();
    }

    // 4. Create Subscription
    const date = new Date();
    date.setDate(date.getDate() + 1); 
    const startAtTimestamp = Math.floor(date.getTime() / 1000); 

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_id: customerId,
      total_count: 360,
      quantity: 1,
      start_at: startAtTimestamp,
      customer_notify: 1,
      notes: { userId, email, name: fullName }, 
    });

    res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      key: process.env.RAZORPAY_KEY_ID,
      // Send FRESH DB data back to frontend
      user_name: fullName,
      user_email: email,
      user_contact: userPhone 
    });

  } catch (err) {
    console.error("Subscription Error:", err);
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