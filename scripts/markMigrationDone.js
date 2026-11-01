const { sequelize } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to TiDB.");

    // Check if SequelizeMeta table exists, if so insert the stuck migration
    await sequelize.query(`
      INSERT INTO SequelizeMeta (name) 
      SELECT '20260916181500-add-channel-metadata-fields.js'
      WHERE NOT EXISTS (
        SELECT 1 FROM SequelizeMeta WHERE name = '20260916181500-add-channel-metadata-fields.js'
      );
    `);

    console.log("Migration '20260916181500-add-channel-metadata-fields.js' successfully marked as completed!");
  } catch (err) {
    console.error("Error marking migration:", err.message);
  } finally {
    process.exit();
  }
})();
