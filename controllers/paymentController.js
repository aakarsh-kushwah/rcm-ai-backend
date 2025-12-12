const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../config/db");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.createSubscription = async (req, res) => {
  try {
    const { id: userId, email, fullName: name, phone } = req.user;
    const userPhone = phone || "9000090000"; 

    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      return res.status(500).json({ success: false, message: "Plan ID missing." });
    }

    // 1. Check DB for existing Customer ID
    let user = await db.User.findByPk(userId);
    let customerId = user.razorpayCustomerId;

    // 2. Logic to Get or Create Customer ID
    if (!customerId || !customerId.startsWith("cust_")) {
        console.log("Local ID missing. Creating Razorpay Customer...");
        
        try {
            // Attempt to create
            const customer = await razorpay.customers.create({
                name: name,
                contact: userPhone,
                email: email,
                fail_existing: 0, 
            });
            customerId = customer.id;
            console.log("✅ Created New Customer:", customerId);

        } catch (error) {
            // If customer exists, Fetch by Email
            if (error.statusCode === 400 && error.error.description.includes('already exists')) {
                console.log("⚠️ Customer exists. Fetching from Razorpay...");
                const existing = await razorpay.customers.all({ email: email, count: 1 });
                
                if (existing.items && existing.items.length > 0) {
                    customerId = existing.items[0].id;
                    console.log("✅ Fetched Existing ID:", customerId);
                } else {
                    // Fallback: If email not found, create with a slightly modified email or throw
                    throw new Error("Customer exists but could not be fetched.");
                }
            } else {
                throw error;
            }
        }

        // Save to DB
        user.razorpayCustomerId = customerId;
        await user.save();
    }

    // 3. Time Logic (Start Tomorrow)
    const date = new Date();
    date.setDate(date.getDate() + 1); 
    const startAtTimestamp = Math.floor(date.getTime() / 1000); 

    // 4. Create Subscription
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_id: customerId,
      total_count: 360,
      quantity: 1,
      start_at: startAtTimestamp,
      customer_notify: 1,
      notes: { userId, email, name }, 
    });

    res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      key: process.env.RAZORPAY_KEY_ID,
      user_name: name,
      user_email: email,
      user_contact: userPhone
    });

  } catch (err) {
    console.error("Subscription Error:", err);
    res.status(500).json({ success: false, message: err.message || "Failed to create subscription." });
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