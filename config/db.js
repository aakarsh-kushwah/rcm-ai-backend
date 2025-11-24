require('dotenv').config();
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const db = {};

/**
 * ⚙️ DATABASE CONFIGURATION
 */
const dbConfig = {
    // ✅ FIX: 'localhost' ki jagah '127.0.0.1' use karein
    // Isse ECONNREFUSED ::1:3306 wala error solve ho jayega
    host: process.env.DB_HOST || '127.0.0.1', 
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'rcm_db',
    port: process.env.DB_PORT || 3306,
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
        // 1. DATABASE CHECK & CREATION
        const connection = await mysql.createConnection({ 
            host: dbConfig.host, 
            port: dbConfig.port, 
            user: dbConfig.user, 
            password: dbConfig.password 
        });
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        // 2. SEQUELIZE INSTANCE INITIALIZATION
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

        // 3. CONNECTION TEST
        await sequelize.authenticate();
        console.log('🚀 Database connection established successfully.');

        // 4. LOAD MODELS
        db.User = require('../models/user.model')(sequelize);
        db.ChatMessage = require('../models/chatMessage.model')(sequelize);
        db.Subscriber = require('../models/subscriber.model')(sequelize);
        db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
        db.ProductVideo = require('../models/productVideo.model')(sequelize);
        db.DailyReport = require('../models/DailyReport.model')(sequelize); 

        // 5. DEFINE ASSOCIATIONS
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        db.User.hasMany(db.DailyReport, { foreignKey: 'user_id', as: 'dailyReports' });
        db.DailyReport.belongsTo(db.User, { foreignKey: 'user_id', as: 'user' });

        // 6. EXPORT INSTANCE
        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // 7. SYNC DATABASE
        const syncOptions = { alter: true }; 
        await sequelize.sync(syncOptions);

        console.log(`✅ All models synchronized successfully. Mode: ${process.env.NODE_ENV || 'Production'}`);

    } catch (error) {
        console.error('❌ FATAL: Database Initialization Failed:', error.message);
        process.exit(1); 
    }
}

module.exports = { db, initialize };