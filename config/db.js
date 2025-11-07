// backend/config/db.js
const config = require('./config.json');
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const db = {};

async function initialize() {
  try {
    const { host, port, user, password, database } = config.database;

    const connection = await mysql.createConnection({ host, port, user, password });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\`;`);
    await connection.end();
    console.log('✅ Database checked/created successfully.');

    const sequelize = new Sequelize(database, user, password, {
      host,
      port,
      dialect: 'mysql',
      logging: false, 
      pool: { max: 3, min: 0, acquire: 30000, idle: 10000 }
    });

    await sequelize.authenticate();
    console.log('✅ Connection to database established successfully.');

    // Load models
    db.User = require('../models/user.model')(sequelize);
    db.ChatMessage = require('../models/chatMessage.model')(sequelize);
    db.Subscriber = require('../models/subscriber.model')(sequelize);
    db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
    db.ProductVideo = require('../models/productVideo.model')(sequelize);

    // Define associations
    db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
    db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

    db.Sequelize = Sequelize;
    db.sequelize = sequelize;

    // --- 👇 YEH BADLAAV ZAROORI HAI (STEP 1) ---
    console.log('Syncing models with alter: true and foreignKeyChecks: false...');
    
    // Temporarily foreign key checks ko disable karein (ChatMessage error ke liye)
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0', null, {});

    // Ab alter chalayein (ProductVideo column ke liye)
    await sequelize.sync({ alter: true });

    // Wapas enable karein
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1', null, {});
    // --- 👆 YEH BADLAAV ZAROORI HAI (STEP 1) ---

    console.log('✅ All models were synchronized successfully (Step 1 Complete).');
  } catch (error) {
    console.error('❌ Unable to initialize the database:', error);
    throw error;
  }
}

module.exports = { db, initialize };