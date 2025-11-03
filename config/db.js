// backend/config/db.js
const config = require('./config.json');
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const db = {};

async function initialize() {
  try {
    const { host, port, user, password, database } = config.database;

    // ✅ Create database if it doesn’t exist
    // (यह ठीक है, लेकिन हम इस कनेक्शन को तुरंत बंद कर देंगे)
    const connection = await mysql.createConnection({ host, port, user, password });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\`;`);
    await connection.end(); // ✅ कनेक्शन को तुरंत बंद करें
    console.log('✅ Database checked/created successfully.');

    // ✅ Connect Sequelize
    const sequelize = new Sequelize(database, user, password, {
      host,
      port,
      dialect: 'mysql',
      logging: false, // ✅ प्रोडक्शन के लिए 'false' सही है
      
      // --- ✅ "PRODUCTION READY" / "HEAVY TRAFFIC" फिक्स ---
      // यह 'max_user_connections' एरर को ठीक करता है
      pool: {
        max: 3,     // 5 की जगह सिर्फ 3 कनेक्शन का पूल बनाएँ
        min: 0,     // 0 कनेक्शन रखें जब सर्वर इस्तेमाल में न हो
        acquire: 30000, // 30 सेकंड तक कनेक्शन का इंतज़ार करें
        idle: 10000    // 10 सेकंड तक 'idle' (बेकार) कनेक्शन को खुला रखें
      }
      // --- फिक्स खत्म ---
    });

    await sequelize.authenticate();
    console.log('✅ Connection to database established successfully.');

    // ✅ Load models
    db.User = require('../models/user.model')(sequelize);
    db.ChatMessage = require('../models/chatMessage.model')(sequelize);
    db.Subscriber = require('../models/subscriber.model')(sequelize);
    db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
    db.ProductVideo = require('../models/productVideo.model')(sequelize);

    // ✅ Define associations
    db.User.hasMany(db.ChatMessage, {
      foreignKey: 'userId',
      as: 'chatMessages',
    });

    db.ChatMessage.belongsTo(db.User, {
      foreignKey: 'userId',
      as: 'User',
    });

    // ✅ Store Sequelize instances
    db.Sequelize = Sequelize;
    db.sequelize = sequelize;

    // ✅ Sync models
    await sequelize.sync({ alter: false }); // 'alter: false' प्रोडक्शन के लिए सही है
    console.log('✅ All models were synchronized successfully.');
  } catch (error) {
    console.error('❌ Unable to initialize the database:', error);
    throw error;
  }
}

module.exports = { db, initialize };