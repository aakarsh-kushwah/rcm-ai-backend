/**
 * One-off script. Run manually: npm run seed:admin
 * Requires SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in env (no hardcoded defaults).
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { logger } = require("../utils/logger");
const { connectDB, sequelize, Admin } = require("../models");

const SALT_ROUNDS = 10; // keep identical to authController

(async () => {
    const email = process.env.SUPER_ADMIN_EMAIL;
    const password = process.env.SUPER_ADMIN_PASSWORD;

    if (!email || !password || password.length < 12) {
        logger.error("Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (min 12 chars) before running.");
        process.exit(1);
    }

    try {
        await connectDB();
        const existing = await Admin.findOne({ where: { email } });

        if (!existing) {
            await Admin.create({
                name: "Super Admin",
                email,
                masterPassword: await bcrypt.hash(password, SALT_ROUNDS),
                role: "SUPER_ADMIN",
                status: "active",
                isApproved: true,
            });
            logger.info({ email }, "Super Admin created");
        } else {
            logger.info({ email }, "Super Admin already exists (password NOT changed)");
            if (existing.role !== "SUPER_ADMIN" || !existing.isApproved || existing.status !== "active") {
                await existing.update({ role: "SUPER_ADMIN", status: "active", isApproved: true });
                logger.info("Super Admin role/status repaired");
            }
        }
        await sequelize.close();
        process.exit(0);
    } catch (err) {
        logger.error({ err: err.message }, "Seeding failed");
        process.exit(1);
    }
})();