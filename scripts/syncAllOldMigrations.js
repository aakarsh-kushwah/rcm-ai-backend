const fs = require('fs');
const path = require('path');
const { sequelize } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to TiDB.");

    // Detect column name in SequelizeMeta
    const [cols] = await sequelize.query("DESCRIBE SequelizeMeta;");
    const colName = cols.some(c => c.Field === 'name') ? 'name' : 'version';

    // Get all migration files from migrations folder
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const allFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js'));

    // Filter out the new Lifelines migration
    const oldMigrations = allFiles.filter(f => !f.includes('create-lifelines-tables'));

    console.log(`Found ${oldMigrations.length} existing upstream migrations.`);

    for (const file of oldMigrations) {
      await sequelize.query(`
        INSERT INTO SequelizeMeta (${colName})
        SELECT '${file}'
        WHERE NOT EXISTS (
          SELECT 1 FROM SequelizeMeta WHERE ${colName} = '${file}'
        );
      `);
    }

    console.log("All existing upstream migrations marked as synced in SequelizeMeta!");
  } catch (err) {
    console.error("Sync error:", err.message);
  } finally {
    process.exit();
  }
})();
