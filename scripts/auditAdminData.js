/**
 * @file rcm-ai-backend/scripts/auditAdminData.js
 * @description Part 1 & Part 5 Audit script for database ground truth on Users and Admins.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize } = require('../config/db');

async function runAudit() {
    try {
        await sequelize.authenticate();
        console.log("=== DB CONNECTED ===");

        // 1. Users where role or name/email matches admin or Sanyog
        console.log("\n--- 1. Users table audit ---");
        const [users] = await sequelize.query("SELECT id, email, full_name, role, status FROM users;");
        console.log("Users count:", users.length);
        console.log("Users:", users);

        // 2. All Admins
        console.log("\n--- 2. SELECT * FROM admins ---");
        const [admins] = await sequelize.query("SELECT * FROM admins;");
        console.log("Admins count:", admins.length);
        console.log("Admins:", admins);

        // 3. Describe Users
        console.log("\n--- 3. DESCRIBE users ---");
        const [userDesc] = await sequelize.query("DESCRIBE users;");
        console.log(userDesc);

        // 4. Describe Admins
        console.log("\n--- 4. DESCRIBE admins ---");
        const [adminDesc] = await sequelize.query("DESCRIBE admins;");
        console.log(adminDesc);

        // 5. Search for "Sanyog" across database tables
        console.log("\n--- 5. Search for 'Sanyog' across all tables ---");
        const [tablesResult] = await sequelize.query("SHOW TABLES;");
        const tableKeys = tablesResult.map(t => Object.values(t)[0]);
        for (const tbl of tableKeys) {
            try {
                const [columns] = await sequelize.query(`SHOW COLUMNS FROM \`${tbl}\`;`);
                const stringCols = columns.filter(c => c.Type.includes('char') || c.Type.includes('text')).map(c => c.Field);
                if (stringCols.length > 0) {
                    const conditions = stringCols.map(col => `\`${col}\` LIKE '%Sanyog%'`).join(' OR ');
                    const [matches] = await sequelize.query(`SELECT * FROM \`${tbl}\` WHERE ${conditions};`);
                    if (matches.length > 0) {
                        console.log(`⚠️ FOUND 'Sanyog' in table \`${tbl}\`:`, matches);
                    }
                }
            } catch (err) {
                // ignore
            }
        }

        await sequelize.close();
        process.exit(0);
    } catch (error) {
        console.error("Audit error:", error);
        process.exit(1);
    }
}

runAudit();
