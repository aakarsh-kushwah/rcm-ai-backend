const { sequelize } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Connected to TiDB successfully.\n");

    const [t1] = await sequelize.query("DESCRIBE rcm_identities;");
    console.log("=== rcm_identities SCHEMA ===");
    console.table(t1.map(r => ({ Field: r.Field, Type: r.Type, Key: r.Key, Null: r.Null })));

    const [t2] = await sequelize.query("DESCRIBE rcm_downline_nodes;");
    console.log("\n=== rcm_downline_nodes SCHEMA ===");
    console.table(t2.map(r => ({ Field: r.Field, Type: r.Type, Key: r.Key, Null: r.Null })));
  } catch (err) {
    console.error("Schema check error:", err.message);
  } finally {
    process.exit();
  }
})();
