/**
 * @file rcm-ai-backend/scripts/migrate-instagram-tables.js
 * @description Migration script for Instagram tables & high-write user_seen_content table with TTL in TiDB.
 */

const { sequelize } = require('../config/db');
const { InstagramAccount, InstagramReel } = require('../models');

async function migrate() {
  console.log('🚀 Starting Instagram & Seen Content tables migration...');

  try {
    // Authenticate DB connection
    await sequelize.authenticate();
    console.log('✅ Database connection authenticated successfully.');

    // 1. Sync InstagramAccount (no alter, safe mode)
    console.log('⏳ Syncing InstagramAccount table...');
    await InstagramAccount.sync({ alter: false });
    console.log('✅ InstagramAccount table synced successfully.');

    // 2. Sync InstagramReel (no alter, safe mode)
    console.log('⏳ Syncing InstagramReel table...');
    await InstagramReel.sync({ alter: false });
    console.log('✅ InstagramReel table synced successfully.');

    // 3. Create high-write table user_seen_content with TTL via raw SQL
    console.log('⏳ Creating high-write user_seen_content table with TiDB TTL...');
    const ddlWithTTL = `
      CREATE TABLE IF NOT EXISTS user_seen_content (
        user_id    BIGINT   NOT NULL,
        platform   TINYINT  NOT NULL COMMENT '1=youtube, 2=instagram',
        content_id BIGINT   NOT NULL,
        seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, platform, content_id)
      ) TTL = \`seen_at\` + INTERVAL 48 HOUR TTL_ENABLE = 'ON';
    `;

    try {
      await sequelize.query(ddlWithTTL);
      console.log('✅ user_seen_content table created successfully with TTL enabled.');
    } catch (ttlErr) {
      console.warn('⚠️ TTL clause failed or unsupported in this TiDB instance/version. Falling back to standard CREATE TABLE without TTL...', ttlErr.message);
      const ddlFallback = `
        CREATE TABLE IF NOT EXISTS user_seen_content (
          user_id    BIGINT   NOT NULL,
          platform   TINYINT  NOT NULL COMMENT '1=youtube, 2=instagram',
          content_id BIGINT   NOT NULL,
          seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, platform, content_id)
        );
      `;
      await sequelize.query(ddlFallback);
      console.log('✅ user_seen_content table created successfully (without TTL).');
    }

    console.log('\n🎉 All Instagram and Seen Content migrations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
