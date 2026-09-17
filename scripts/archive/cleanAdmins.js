/**
 * @file scripts/cleanAdmins.js
 * @description Raw proof and cleanup of admins table: Keep only rcmaiasistant@gmail.com, hash Titan@123, delete others.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { sequelize } = require("../config/db");
const Admin = require("../models/admin.model")(sequelize);
const bcrypt = require("bcryptjs");

async function runAdminCleanup() {
    try {
        await sequelize.authenticate();
        console.log("=== STEP B.1: RAW QUERY OUTPUT BEFORE DELETION ===");
        const [beforeRows] = await sequelize.query("SELECT id, name, email, role, status, is_approved, created_at FROM admins;");
        console.log(JSON.stringify(beforeRows, null, 2));

        console.log("\n=== STEP B.2 & B.3: KEEPING ONLY rcmaiasistant@gmail.com & DELETING OTHERS ===");
        const targetEmail = "rcmaiasistant@gmail.com";
        const newPasswordPlain = "Titan@123";
        const hashedPassword = await bcrypt.hash(newPasswordPlain, 10);

        // Delete all admins except targetEmail
        const [deleteResult] = await sequelize.query(`DELETE FROM admins WHERE email != '${targetEmail}';`);
        console.log(`Deleted other admins successfully.`);

        // Upsert targetEmail admin with hashed password Titan@123
        const [existing] = await sequelize.query(`SELECT id FROM admins WHERE email = '${targetEmail}';`);
        if (existing.length > 0) {
            await sequelize.query(`UPDATE admins SET master_password = '${hashedPassword}', role = 'SUPER_ADMIN', status = 'active', is_approved = 1 WHERE email = '${targetEmail}';`);
            console.log(`Updated ${targetEmail} password to hashed 'Titan@123'.`);
        } else {
            await Admin.create({
                name: "Super Admin",
                email: targetEmail,
                masterPassword: hashedPassword,
                role: "SUPER_ADMIN",
                status: "active",
                isApproved: true
            });
            console.log(`Created ${targetEmail} with hashed 'Titan@123'.`);
        }

        console.log("\n=== STEP B.5: FRESH RAW QUERY OUTPUT AFTER CLEANUP ===");
        const [afterRows] = await sequelize.query("SELECT id, name, email, role, status, is_approved, created_at FROM admins;");
        console.log(JSON.stringify(afterRows, null, 2));

    } catch (error) {
        console.error("❌ Admin Cleanup Error:", error.message);
    } finally {
        await sequelize.close();
    }
}

runAdminCleanup();
