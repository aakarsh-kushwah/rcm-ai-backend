require('dotenv').config();
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');
const path = require('path');

// 1. Config.json Load Logic
let fileConfig = {};
try { 
    fileConfig = require('./config.json'); 
} catch (e) { 
    console.warn("⚠️ config.json not found, falling back to ENV variables.");
}

const db = {};

// 2. SSL Configuration (TiDB Requires This)
const tidbSSL = {
    require: true,
    rejectUnauthorized: true, 
    minVersion: 'TLSv1.2'
};

const dbConfig = {
    host: process.env.DB_HOST || fileConfig.database?.host,
    user: process.env.DB_USER || fileConfig.database?.user,
    password: process.env.DB_PASSWORD || fileConfig.database?.password,
    database: process.env.DB_NAME || fileConfig.database?.database || 'rcm_db',
    port: process.env.DB_PORT || fileConfig.database?.port || 4000,
    dialect: 'mysql',
    
    // 🔥 UPDATED: Connection Pool Optimized for 5000+ Users (Render Free Tier)
    pool: {
        max: 20,     // Max 20 connections (Safe for 512MB RAM)
        min: 2,      // 2 always ready for speed
        acquire: 60000, // 60s timeout prevents crash under load
        idle: 10000  // Release unused connections quickly
    },
    
    dialectOptions: {
        decimalNumbers: true, 
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000,
        charset: 'utf8mb4',
        ssl: tidbSSL
    },
    
    timezone: '+05:30', // IST Timezone
    logging: false 
};

// Helper to safely load models
const loadModel = (sequelize, filePath, modelName) => {
    try {
        const modelDef = require(filePath);
        db[modelName] = modelDef(sequelize, Sequelize);
    } catch (e) {
        console.warn(`⚠️ Note: Model ${modelName} skipped/missing.`);
    }
};

async function initialize() {
    try {
        console.log(`📡 Connecting to Database Host: ${dbConfig.host}`);

        // 1. Pre-flight Check
        try {
            const connection = await mysql.createConnection({
                host: dbConfig.host, 
                port: dbConfig.port, 
                user: dbConfig.user, 
                password: dbConfig.password,
                connectTimeout: 20000,
                ssl: tidbSSL
            });
            await connection.end();
        } catch (preError) {
            console.warn("⚠️ Pre-flight check warning:", preError.message);
        }

        // 2. Initialize Sequelize
        const sequelize = new Sequelize(dbConfig.database, dbConfig.user, dbConfig.password, {
            host: dbConfig.host, 
            port: dbConfig.port, 
            dialect: dbConfig.dialect,
            pool: dbConfig.pool, 
            dialectOptions: dbConfig.dialectOptions, 
            timezone: dbConfig.timezone,
            define: {
                charset: 'utf8mb4',
                collate: 'utf8mb4_unicode_ci',
                timestamps: true
            },
            logging: false, 
        });

        // 3. Authenticate
        await sequelize.authenticate();
        console.log('🚀 TiDB Database Connection: ESTABLISHED');

        // --- MODEL REGISTRY ---
        loadModel(sequelize, '../models/user.model', 'User');
        loadModel(sequelize, '../models/chatMessage.model', 'ChatMessage');
        loadModel(sequelize, '../models/VoiceResponse', 'VoiceResponse');
        loadModel(sequelize, '../models/FAQ', 'FAQ');
        loadModel(sequelize, '../models/DailyReport.model', 'DailyReport');
        loadModel(sequelize, '../models/leaderVideo.model', 'LeaderVideo');
        loadModel(sequelize, '../models/productVideo.model', 'ProductVideo');
        loadModel(sequelize, '../models/subscriber.model', 'Subscriber'); 
        loadModel(sequelize, '../models/Payment', 'Payment');

        // Associations
        Object.keys(db).forEach(modelName => {
            if (db[modelName] && db[modelName].associate) {
                db[modelName].associate(db);
            }
        });
        
        // Manual Associations (Fallback)
        if (db.User && db.ChatMessage) {
            db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
            db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });
        }

        if(db.DailyReport && db.User) {
             db.User.hasMany(db.DailyReport, { foreignKey: 'user_id' });
             db.DailyReport.belongsTo(db.User, { foreignKey: 'user_id' });
        }

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // 🛡️ SYNC STRATEGY (Updated with Safety)
        console.log("⏳ Syncing Models...");
        try {
            await sequelize.sync({ alter: true });
            console.log(`✅ System Online & Models Synced.`);
        } catch (syncErr) {
            console.warn("⚠️ TiDB 'Alter' Error (Ignored):", syncErr.message);
            console.log("🔄 Trying Safe Sync (No Alter)...");
            // Agar alter fail hua, to normal sync try karega (Data loss nahi hoga)
            await sequelize.sync(); 
            console.log(`✅ System Online (Safe Mode).`);
        }

    } catch (error) {
        console.error('🔥 FATAL DB ERROR:', error.original ? error.original.message : error.message);
        throw error;
    }
}

module.exports = { db, initialize };