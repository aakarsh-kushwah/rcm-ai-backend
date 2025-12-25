const { db, initialize } = require('./src/config/db');

async function fixDb() {
    try {
        await initialize();
        
        // 1. Add voiceType column
        await db.sequelize.query(
            "ALTER TABLE FAQs ADD COLUMN voiceType ENUM('ELEVENLABS', 'EDGE', 'NONE') DEFAULT 'NONE';"
        ).catch(e => console.log("voiceType exists or skipped"));

        // 2. Add status column
        await db.sequelize.query(
            "ALTER TABLE FAQs ADD COLUMN status ENUM('APPROVED', 'PENDING_REVIEW') DEFAULT 'APPROVED';"
        ).catch(e => console.log("status exists or skipped"));

        console.log("✅ Database Schema Updated!");
        process.exit();
    } catch (error) {
        console.error("Migration Error:", error);
    }
}

fixDb();