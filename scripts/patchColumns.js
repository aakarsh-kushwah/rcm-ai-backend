const { sequelize } = require('../config/db');

async function patchColumns() {
  console.log('🔄 [DB PATCH] Checking and adding missing columns in TiDB...');
  const queries = [
    // Downline Nodes table columns:
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS parent_id VARCHAR(64) NULL;",
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS status TINYINT DEFAULT 1;",
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS repurchase_amt DECIMAL(14,2) DEFAULT 0;",
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS self_pv DECIMAL(14,2) DEFAULT 0;",
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS current_pv DECIMAL(14,2) DEFAULT 0;",
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS total_group_pv DECIMAL(14,2) DEFAULT 0;",
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS children_count INT DEFAULT 0;",
    "ALTER TABLE rcm_downline_nodes ADD COLUMN IF NOT EXISTS level INT DEFAULT 0;",
    
    // Monthly Turnover History table columns:
    "ALTER TABLE rcm_monthly_turnover_history ADD COLUMN IF NOT EXISTS month_key VARCHAR(32) NULL;",
    "ALTER TABLE rcm_monthly_turnover_history ADD COLUMN IF NOT EXISTS total_pv DECIMAL(14,2) DEFAULT 0;",
    "ALTER TABLE rcm_monthly_turnover_history ADD COLUMN IF NOT EXISTS self_pv DECIMAL(14,2) DEFAULT 0;",
    "ALTER TABLE rcm_monthly_turnover_history ADD COLUMN IF NOT EXISTS leg_a_pv DECIMAL(14,2) DEFAULT 0;",
    "ALTER TABLE rcm_monthly_turnover_history ADD COLUMN IF NOT EXISTS leg_b_pv DECIMAL(14,2) DEFAULT 0;",

    // Users table columns:
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS rcm_buyer_id VARCHAR(64) NULL;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS rcm_password_encrypted VARCHAR(512) NULL;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sync_at DATETIME NULL;"
  ];

  for (const sql of queries) {
    try {
      await sequelize.query(sql);
    } catch (err) {
      if (!err.message.includes('Duplicate column')) {
        console.warn(`[DB PATCH WARN] ${err.message}`);
      }
    }
  }
  console.log('✅ [DB PATCH COMPLETE] All required schema columns are active.');
}

module.exports = patchColumns;
if (require.main === module) {
  patchColumns().then(() => process.exit(0));
}
