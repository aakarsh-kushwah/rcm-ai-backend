const { sequelize, Sequelize } = require('./config/db');
const migration = require('./migrations/20260919180000-add-shorts-engine-tables-and-columns.js');

async function run() {
  try {
    await sequelize.authenticate();
    console.log('Connected to DB.');
    await migration.up(sequelize.getQueryInterface(), Sequelize);
    console.log('Shorts migration executed successfully.');
    
    try {
      await sequelize.query(
        "INSERT IGNORE INTO SequelizeMeta (name) VALUES ('20260919180000-add-shorts-engine-tables-and-columns.js')"
      );
    } catch (e) {
      console.log('SequelizeMeta update note:', e.message);
    }

    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
