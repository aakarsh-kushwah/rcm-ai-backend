const { Sequelize } = require('sequelize');
const c = require('./config/config.json').production;
const s = new Sequelize(c.database, c.username, c.password, c);

async function run() {
  try {
    await s.query(
      "INSERT INTO SequelizeMeta (name) VALUES ('20260914193520-add-last-known-live-start-time-to-channels.js'), ('20260915065558-add-last-known-live-start-time-again-to-channels.js')"
    );
    console.log('marked as done');
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

run();
