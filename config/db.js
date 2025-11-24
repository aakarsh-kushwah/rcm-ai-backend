require('dotenv').config();
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

// Config.json fallback
let config;
try {
    config = require('./config.json');
} catch (error) {
    config = { database: {} };
}

const db = {};

const dbConfig = {
    host: process.env.DB_HOST || config.database.host || '127.0.0.1',
    user: process.env.DB_USER || config.database.user || 'root',
    password: process.env.DB_PASSWORD || config.database.password || '',
    database: process.env.DB_NAME || config.database.database || 'rcm_db',
    port: process.env.DB_PORT || config.database.port || 3306,
    dialect: 'mysql',
    
    pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 20,
        min: 0,
        acquire: 30000,
        idle: 10000
    },
    
    dialectOptions: {
        decimalNumbers: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000,
    },
    
    logging: process.env.NODE_ENV === 'development' ? console.log : false
};

async function initialize() {
    try {
        console.log(`📡 Connecting to Database Host: ${dbConfig.host}`);

        // 1. Connection & DB Check
        const connection = await mysql.createConnection({ 
            host: dbConfig.host, 
            port: dbConfig.port, 
            user: dbConfig.user, 
            password: dbConfig.password 
        });
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        // 2. Sequelize Init
        const sequelize = new Sequelize(
            dbConfig.database,
            dbConfig.user,
            dbConfig.password,
            {
                host: dbConfig.host,
                port: dbConfig.port,
                dialect: dbConfig.dialect,
                pool: dbConfig.pool,
                dialectOptions: dbConfig.dialectOptions,
                logging: dbConfig.logging,
            }
        );

        await sequelize.authenticate();
        console.log('🚀 Database connection established successfully.');

        // 3. Load Models
        db.User = require('../models/user.model')(sequelize);
        db.ChatMessage = require('../models/chatMessage.model')(sequelize);
        db.Subscriber = require('../models/subscriber.model')(sequelize);
        db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
        db.ProductVideo = require('../models/productVideo.model')(sequelize);
        // ✅ Ensure spelling is correct here
        db.DailyReport = require('../models/DailyReport.model')(sequelize); 

        // 4. Define Associations
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        db.User.hasMany(db.DailyReport, { foreignKey: 'user_id', as: 'dailyReports' });
        db.DailyReport.belongsTo(db.User, { foreignKey: 'user_id', as: 'user' });

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // =========================================================
        // 🛠️ FIX FOR FOREIGN KEY ERROR
        // =========================================================
        console.log("🔄 Syncing Database (Safe Mode)...");
        
        // Step A: Disable Foreign Key Checks (Rules todne ki permission)
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { raw: true });

        // Step B: Sync Tables (Ab error nahi aayega)
        await sequelize.sync({ alter: true });

        // Step C: Enable Foreign Key Checks (Rules wapas lagao)
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { raw: true });

        console.log(`✅ All models synchronized successfully.`);

    } catch (error) {
        console.error('❌ FATAL: Database Initialization Failed:', error.message);
        process.exit(1); 
    }
}

module.exports = { db, initialize };