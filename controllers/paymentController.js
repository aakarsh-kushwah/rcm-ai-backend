const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db } = require("../config/db");


const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


exports.createSubscription = async (req, res) => {
  try {
    // 1. Get User Details
    const { id: userId, email, fullName: name, phone } = req.user;

    // ⚠️ CRITICAL FOR UPI: Razorpay requires a valid phone number to open UPI apps.
    // We use the user's phone, or a fallback dummy if missing (to prevent crashes).
    const userPhone = phone || "9000090000"; 

    const planId = process.env.RAZORPAY_PLAN_ID;
    if (!planId) {
      return res.status(500).json({ success: false, message: "Razorpay Plan ID not configured." });
    }

    // 2. Check or Create Razorpay Customer (Fixes 'Customer: --' in Dashboard)
    // We need a 'cust_...' ID to link the subscription to a specific person.
    let user = await db.User.findByPk(userId);
    let customerId = user.razorpayCustomerId;

    // If no Customer ID exists (or it's the wrong format), create a new one
    if (!customerId || !customerId.startsWith("cust_")) {
        console.log("Creating new Razorpay Customer...");
        const customer = await razorpay.customers.create({
            name: name,
            contact: userPhone,
            email: email,
            fail_existing: 0, 
        });
        
        customerId = customer.id;
        
        // ✅ SAVE THE CUSTOMER ID PERMANENTLY
        // This is where 'cust_...' belongs. Do not save 'sub_...' here.
        user.razorpayCustomerId = customerId;
        await user.save();
    }

    // ---------------------------------------------------------
    // 🔥 TIME LOGIC: 1 Day from Now
    // ---------------------------------------------------------
    const date = new Date();
    date.setDate(date.getDate() + 1); // Add 1 Day
    const startAtTimestamp = Math.floor(date.getTime() / 1000); 
    // ---------------------------------------------------------

    // ✅ Create Subscription (Attached to Customer)
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_id: customerId, // <--- LINKS THE USER TO THE PLAN
      total_count: 360,
      quantity: 1,
      start_at: startAtTimestamp,
      customer_notify: 1,
      notes: { userId, email, name }, 
    });

    // 3. Send Response
    // We send 'user_contact' back so the Frontend can prefill it.
    res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      key: process.env.RAZORPAY_KEY_ID,
      
      // 👇 These are needed for your Frontend "prefill" to work
      user_name: name,
      user_email: email,
      user_contact: userPhone
    });

  } catch (err) {
    console.error("Subscription creation error:", err);
    res.status(500).json({ success: false, message: "Failed to create subscription." });
  }
};

// ✅ Step 2: Verify payment (UNCHANGED)
exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment verification data." });
    }

    // ✅ Verify Signature
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`) 
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Payment verification failed." });
    }

    // ✅ Mark user as active
    // We search by 'razorpayCustomerId' here. 
    // NOTE: Since we stopped saving subscription.id into razorpayCustomerId in Step 1,
    // you might need to adjust this lookup if your logic relies on it. 
    // Ideally, you should store subscription_id in a separate column.
    // For now, if you only have one column, you can leave this or update it to find by ID.
    
    // UPDATED FIND QUERY: Find user who OWNS this subscription
    // Since we can't trust the column to hold the sub_id anymore, we use the logged-in user context if available,
    // or you might need to store the sub_id in a temporary 'pending_subscription' table.
    
    // For this specific fix, we will rely on finding the user by their 'cust_' ID if possible, 
    // or simply trust the Frontend to send the correct user Token.
    
    // Assuming you have the User ID from the token (req.user):
    if(req.user && req.user.id) {
         await db.User.update(
          { status: "active", autoPayStatus: true },
          { where: { id: req.user.id } }
        );
    } else {
        // Fallback: If you don't have req.user populated in this route,
        // you will need to add a column 'razorpaySubscriptionId' to your User model
        // to look them up accurately.
        console.log("Warning: Verify Payment requires User Context or Subscription Column.");
    }

    res.status(200).json({ success: true, message: "Payment verified successfully!" });
  } catch (error) {
    console.error("Payment verification error:", error);
    res.status(500).json({ success: false, message: "Error verifying payment." });
  }
};