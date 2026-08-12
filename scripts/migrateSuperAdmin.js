/**
 * @file rcm-ai-backend/scripts/migrateSuperAdmin.js
 * @description Migrates/upserts super admin rcmaiasistant@gmail.com with a bcrypt-hashed secure password.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/db');
const { Admin } = require('../models');

async function migrateSuperAdmin() {
    try {
        await sequelize.authenticate();
        console.log("✅ Database Connected Successfully.");

        // 1. Generate secure random password
        const rawPassword = "TitanSecureAdmin#" + Math.random().toString(36).slice(-8) + "!";
        const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
        const hashedPassword = await bcrypt.hash(rawPassword, saltRounds);

        // 2. Upsert admin rcmaiasistant@gmail.com
        const [admin, created] = await Admin.findOrCreate({
            where: { email: 'rcmaiasistant@gmail.com' },
            defaults: {
                name: 'RCM Super Admin',
                email: 'rcmaiasistant@gmail.com',
                masterPassword: hashedPassword,
                role: 'SUPER_ADMIN',
                status: 'active',
                isApproved: true
            }
        });

        if (!created) {
            admin.masterPassword = hashedPassword;
            admin.role = 'SUPER_ADMIN';
            admin.status = 'active';
            admin.isApproved = true;
            await admin.save();
            console.log("✅ Super Admin updated successfully.");
        } else {
            console.log("✅ Super Admin created successfully.");
        }

        // 3. Verify with raw query as requested
        const [results] = await sequelize.query(`
            SELECT email, role, status, LENGTH(master_password) as pass_len 
            FROM admins 
            WHERE email = 'rcmaiasistant@gmail.com';
        `);

        console.log("\n--- VERIFICATION RESULT ---");
        console.log(results);

        console.log("\n==========================================");
        console.log("🔑 PLAIN-TEXT MASTER PASSWORD (SAVE THIS NOW):");
        console.log(rawPassword);
        console.log("==========================================");

        await sequelize.close();
        process.exit(0);
    } catch (error) {
        console.error("❌ Migration Failed:", error);
        process.exit(1);
    }
}

migrateSuperAdmin();
