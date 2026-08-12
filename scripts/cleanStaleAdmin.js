/**
 * @file rcm-ai-backend/scripts/cleanStaleAdmin.js
 * @description Removes stale Sanyog New Admin from users table.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize } = require('../config/db');

async function cleanStale() {
    try {
        await sequelize.authenticate();
        console.log("=== DB CONNECTED ===");

        // Delete Sanyog New Admin from users table
        const [result] = await sequelize.query("DELETE FROM users WHERE email = 'sanyog.admin.test@gmail.com' OR full_name LIKE '%Sanyog New Admin%';");
        console.log("Deleted stale admin records from users table:", result);

        // Also check admins table
        const [admins] = await sequelize.query("SELECT * FROM admins;");
        console.log("Current admins table records:", admins);

        await sequelize.close();
        process.exit(0);
    } catch (err) {
        console.error("Cleanup failed:", err);
        process.exit(1);
    }
}

cleanStale();
