const { Sequelize } = require('sequelize');
const c = require('./config/config.json').production;
const s = new Sequelize(c.database, c.username, c.password, c);

s.query("UPDATE channels SET is_pinned = true WHERE id = 2")
  .then(() => s.query('SELECT id, name, is_pinned FROM channels'))
  .then(([r]) => { console.log(r); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
