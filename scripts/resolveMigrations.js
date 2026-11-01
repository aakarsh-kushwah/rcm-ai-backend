const { sequelize } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to TiDB successfully.");

    // Detect SequelizeMeta column structure (usually 'name')
    const [cols] = await sequelize.query("DESCRIBE SequelizeMeta;");
    const colName = cols.some(c => c.Field === 'name') ? 'name' : 'version';

    const migrationsToMark = [
      '20260916181500-add-channel-metadata-fields.js',
      '20261026200904-add_razorpaySubscriptionId_to_users.js'
    ];

    for (const mig of migrationsToMark) {
      await sequelize.query(`
        INSERT INTO SequelizeMeta (${colName})
        SELECT '${mig}'
        WHERE NOT EXISTS (
          SELECT 1 FROM SequelizeMeta WHERE ${colName} = '${mig}'
        );
      `);
      console.log(`Marked as completed: ${mig}`);
    }

    console.log("\nMigration conflicts resolved successfully!");
  } catch (err) {
    console.error("Error resolving migrations:", err.message);
  } finally {
    process.exit();
  }
})();
