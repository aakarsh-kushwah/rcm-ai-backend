const { sequelize } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to TiDB successfully.");

    // 1. Add missing column for Google Auth
    await sequelize.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_subscription_id VARCHAR(255) NULL;");
    console.log("Column 'razorpay_subscription_id' verified/added!");

    // 2. Check existing RCM tables
    const [tables] = await sequelize.query("SHOW TABLES LIKE '%rcm_%';");
    console.log("Existing RCM Tables in TiDB:", tables);
  } catch (err) {
    console.error("Database error:", err.message);
  } finally {
    process.exit();
  }
})();
