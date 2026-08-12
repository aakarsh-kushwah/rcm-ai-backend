require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { sequelize } = require("../config/db");
const Admin = require("../models/admin.model")(sequelize);

async function resetAdminPassword() {
    const superAdminEmail = "rcmaiasistant@gmail.com";
    const newHashedPassword = "$2a$10$jF1n70xexS9.CpvJJAGK..sRy17wnPREdpyhbwM2TkyQg9VpRJc8m"; // Hash for "Titan@123"

    try {
        await sequelize.authenticate();
        console.log("✅ [TITAN-DB] Hyper-Scale Connection Established.");

        const [updatedRows] = await Admin.update(
            { masterPassword: newHashedPassword },
            { where: { email: superAdminEmail } }
        );

        if (updatedRows > 0) {
            console.log(`✅ Master password for ${superAdminEmail} updated successfully.`);
        } else {
            console.log(`⚠️ No admin found with email ${superAdminEmail}. Password not updated.`);
        }

    } catch (error) {
        console.error("❌ Error resetting admin password:", error.message);
        process.exit(1);
    } finally {
        await sequelize.close();
        console.log("Database connection closed.");
    }
}

resetAdminPassword();
