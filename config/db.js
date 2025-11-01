/**
 * Database config file
 */
const config = require('./config.json');
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const db = {};

async function initialize() {
  try {
    const { host, port, user, password, database } = config.database;

    // Create database if not exists
    const connection = await mysql.createConnection({ host, port, user, password });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\`;`);
    console.log('✅ Database checked/created successfully.');

    // Connect Sequelize
    const sequelize = new Sequelize(database, user, password, {
      host,
      port,
      dialect: 'mysql',
      logging: false,
    });

    await sequelize.authenticate();
    console.log('✅ Connection to database established successfully.');

    // Load models
    db.User = require('../models/user.model')(sequelize);
    db.ChatMessage = require('../models/chatMessage.model')(sequelize);
    db.Subscriber = require('../models/subscriber.model')(sequelize);
    db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
    db.ProductVideo = require('../models/productVideo.model')(sequelize);

    db.Sequelize = Sequelize;
    db.sequelize = sequelize;

    // Sync all models
    await sequelize.sync({ alter: false });
    console.log('✅ All models were synchronized successfully.');
  } catch (error) {
    console.error('❌ Unable to initialize the database:', error);
    throw error;
  }
}

module.exports = { db, initialize };
