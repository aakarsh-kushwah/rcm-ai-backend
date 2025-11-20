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
    // ✅ NAYE MODELS LOAD KAREIN (Fix: Added explicit .model.js extension)
    db.YoutubeChannel = require('../models/youtubeChannel.model')(sequelize);
    db.YoutubeVideo = require('../models/youtubeVideo.model')(sequelize);


    // Define associations
    db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
    db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });
    
    // ✅ YOUTUBE ASSOCIATIONS
    // One Channel has many Videos. CASCADE delete: channel delete hone par videos bhi hat jayenge.
    db.YoutubeChannel.hasMany(db.YoutubeVideo, { 
        foreignKey: 'channelId', 
        as: 'videos', 
        onDelete: 'CASCADE' 
    });
    db.YoutubeVideo.belongsTo(db.YoutubeChannel, { foreignKey: 'channelId' });


    db.Sequelize = Sequelize;
    db.sequelize = sequelize;

    // Production ready: alter: false to prevent potential table drops
    await sequelize.sync({ alter: false }); 

    console.log('✅ All models were synchronized successfully (Production Mode).');
  } catch (error) {
    console.error('❌ Unable to initialize the database:', error);
    throw error;
  }
}

module.exports = { db, initialize };