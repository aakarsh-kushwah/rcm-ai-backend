const { db } = require('../config/db'); // Import db with Sequelize instance

// ✅ Add Subscriber
const addSubscriber = async (req, res) => {
  try {
    const { name, phone } = req.body;

    if (!name || !phone) {
      return res
        .status(400)
        .json({ success: false, message: 'Name and phone number are required.' });
    }

    // Check if the phone number is already subscribed
    const existing = await db.Subscriber.findOne({
      where: { phoneNumber: phone },
    });

    if (existing) {
      return res
        .status(400)
        .json({ success: false, message: 'This number is already subscribed.' });
    }

    // Create new subscriber
    const newSubscriber = await db.Subscriber.create({
      name,
      phoneNumber: phone,
    });

    res.status(201).json({
      success: true,
      message: 'Successfully subscribed!',
      data: newSubscriber,
    });
  } catch (error) {
    console.error('❌ Subscription Error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to subscribe.', error: error.message });
  }
};

// ✅ Get All Subscribers
const getAllSubscribers = async (req, res) => {
  try {
    const subscribers = await db.Subscriber.findAll({
      order: [['subscribedAt', 'DESC']],
    });

    res.json({ success: true, data: subscribers });
  } catch (error) {
    console.error('❌ Fetch Subscribers Error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to fetch subscribers.', error: error.message });
  }
};

// ✅ यह 'module.exports' आपके 'undefined' एरर को ठीक करता है
module.exports = { addSubscriber, getAllSubscribers };
