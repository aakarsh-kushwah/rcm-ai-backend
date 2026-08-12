require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const { sequelize } = require("../config/db");
const Admin = require("../models/admin.model")(sequelize);

async function queryAdmin() {
    try {
        await sequelize.authenticate();
        console.log("✅ [TITAN-DB] Hyper-Scale Connection Established.");

        const [results, metadata] = await sequelize.query(
            "SELECT id, email, role, status, is_approved, LENGTH(master_password) AS master_password_length FROM admins WHERE email = \'rcmaiasistant@gmail.com\';"
        );

        console.log("RAW output for rcmaiasistant@gmail.com:");
        if (results.length === 0) {
            console.log("ZERO rows found. Record is genuinely missing.");
        } else {
            console.log(JSON.stringify(results[0], null, 2));
        }

    } catch (error) {
        console.error("❌ Error during database query:", error.message);
        process.exit(1);
    } finally {
        await sequelize.close();
        console.log("Database connection closed.");
    }
}

queryAdmin();
