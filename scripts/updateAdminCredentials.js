/**
 * @file rcm-ai-backend/scripts/updateAdminCredentials.js
 * @description Securely updates or creates administrator account credentials for rcmaiasistant@gmail.com
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/db');
const { Admin } = require('../models');

async function updateAdminCredentials() {
    try {
        await sequelize.authenticate();
        console.log("✅ [TITAN DB] Database Connected Successfully.");

        const targetEmail = "rcmaiasistant@gmail.com";
        const plainPassword = "Sayog@kushwah3810";
        const saltRounds = 10;

        console.log(`🔒 Hashing new password for ${targetEmail}...`);
        const hashedPassword = await bcrypt.hash(plainPassword, saltRounds);

        // Check if admin exists in Admin model
        let adminRecord = await Admin.findOne({ where: { email: targetEmail } });

        if (adminRecord) {
            console.log(`📝 Existing admin record found for ${targetEmail}. Updating credentials, role to 'ADMIN', and status to 'active'...`);
            adminRecord.masterPassword = hashedPassword;
            adminRecord.role = 'ADMIN';
            adminRecord.status = 'active';
            adminRecord.isApproved = true;
            await adminRecord.save();
            console.log("✅ Admin record updated successfully.");
        } else {
            console.log(`✨ Admin record not found for ${targetEmail}. Creating new admin record...`);
            adminRecord = await Admin.create({
                name: 'RCM Admin',
                email: targetEmail,
                masterPassword: hashedPassword,
                role: 'ADMIN',
                status: 'active',
                isApproved: true
            });
            console.log("✅ New admin record created successfully.");
        }

        // Verification query
        const [verificationResult] = await sequelize.query(`
            SELECT email, role, status, is_approved, LENGTH(master_password) AS password_length 
            FROM admins 
            WHERE email = :email;
        `, {
            replacements: { email: targetEmail },
            type: sequelize.QueryTypes.SELECT
        });

        console.log("\n==================================================");
        console.log("📊 SUCCESS CONFIRMATION REPORT:");
        console.log("==================================================");
        console.log(verificationResult);
        console.log("✅ Admin credentials updated and verified securely.");
        console.log("==================================================");

        await sequelize.close();
        process.exit(0);
    } catch (error) {
        console.error("❌ Failed to update admin credentials:", error);
        process.exit(1);
    }
}

updateAdminCredentials();
