const { sequelize } = require('../models');

async function run() {
  try {
    await sequelize.authenticate();
    console.log("Database connected for direct schema fix.");

    // Add last_known_live_start_time column if not exists
    await sequelize.query(`
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_known_live_start_time DATETIME NULL;
    `);
    console.log("Column last_known_live_start_time checked/added successfully.");

    process.exit(0);
  } catch (err) {
    console.error("Schema fix failed:", err);
    process.exit(1);
  }
}

run();
