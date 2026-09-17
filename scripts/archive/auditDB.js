/**
 * @file rcm-ai-backend/scripts/auditDB.js
 * @description Comprehensive audit script for TiDB Database tables, schemas, and row counts.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize } = require('../config/db');

async function auditDatabase() {
    try {
        await sequelize.authenticate();
        console.log("✅ Database Connected Successfully.\n");

        // 1. Show Tables
        const [tablesResult] = await sequelize.query("SHOW TABLES;");
        const tableNames = tablesResult.map(t => Object.values(t)[0]);
        console.log(`=== 1. TOTAL TABLES (${tableNames.length}) ===`);
        console.log(tableNames);

        // 2. Row Counts and Schemas
        console.log("\n=== 2. TABLE ROW COUNTS & SCHEMAS ===");
        for (const tableName of tableNames) {
            try {
                const [countResult] = await sequelize.query(`SELECT COUNT(*) as count FROM \`${tableName}\`;`);
                const rowCount = countResult[0].count;
                console.log(`\n--- Table: ${tableName} (Rows: ${rowCount}) ---`);
                
                const [describeResult] = await sequelize.query(`DESCRIBE \`${tableName}\`;`);
                console.table(describeResult);
            } catch (err) {
                console.log(`Error inspecting ${tableName}:`, err.message);
            }
        }

        await sequelize.close();
        process.exit(0);
    } catch (error) {
        console.error("❌ Audit Failed:", error);
        process.exit(1);
    }
}

auditDatabase();
