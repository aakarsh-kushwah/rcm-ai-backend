const { Sequelize } = require('sequelize');
const c = require('./config/config.json').production;
const s = new Sequelize(c.database, c.username, c.password, c);

s.query("SELECT id, name, scheduled_start_time, upcoming_video_id, last_known_live_start_time, upcoming_premiere_at, last_synced_at FROM channels WHERE id = 2")
  .then(([r]) => { console.log(r); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
