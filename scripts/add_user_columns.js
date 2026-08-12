const { sequelize } = require('../config/db');

async function addColumnsToUserTable() {
  try {
    await sequelize.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS status VARCHAR(255) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS google_id VARCHAR(200),
      ADD COLUMN IF NOT EXISTS avatar TEXT;
    `);
    
    // Add unique index on google_id if not exists
    try {
      await sequelize.query(`
        ALTER TABLE users ADD UNIQUE INDEX idx_users_google_id (google_id);
      `);
    } catch (idxErr) {
      console.log('Note: google_id unique index might already exist:', idxErr.message);
    }

    // Relax password and rcm_id NOT NULL constraints for Google OAuth users
    try {
      await sequelize.query('ALTER TABLE users MODIFY COLUMN password VARCHAR(200) NULL;');
      await sequelize.query('ALTER TABLE users MODIFY COLUMN rcm_id VARCHAR(200) NULL;');
      console.log('Successfully relaxed password and rcm_id constraints to allow NULL.');
    } catch (alterErr) {
      console.log('Note on column modification:', alterErr.message);
    }

    console.log('User table migration & column update completed successfully.');
  } catch (error) {
    console.error('Error in user table migration:', error);
  } finally {
    await sequelize.close();
  }
}

addColumnsToUserTable();
