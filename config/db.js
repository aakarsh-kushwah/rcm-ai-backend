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
    rejectUnauthorized: true, // TiDB Cloud certificates are trusted by default
    minVersion: 'TLSv1.2'
};

const dbConfig = {
    // Priority: ENV -> Config.json -> Defaults
    host: process.env.DB_HOST || fileConfig.database?.host || '127.0.0.1',
    user: process.env.DB_USER || fileConfig.database?.user || 'root',
    password: process.env.DB_PASSWORD || fileConfig.database?.password || '',
    database: process.env.DB_NAME || fileConfig.database?.database || 'rcm_db',
    port: process.env.DB_PORT || fileConfig.database?.port || 4000, // TiDB uses 4000
    dialect: 'mysql',
    
    // 🛡️ TiDB/Cloud Pool Settings
    pool: {
        max: 5, // TiDB Serverless handles connections well, but keep it safe
        min: 0,
        acquire: 30000,
        idle: 10000
    },
    
    // ⚡ Dialect Options with SSL
    dialectOptions: {
        decimalNumbers: true, 
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000,
        charset: 'utf8mb4',
        // 👇 CRITICAL FIX FOR TiDB: ENABLE SSL
        ssl: tidbSSL
    },
    
    logging: false 
};

// Helper to safely load models
const loadModel = (sequelize, filePath, modelName) => {
    try {
        const modelDef = require(filePath);
        db[modelName] = modelDef(sequelize, Sequelize);
    } catch (e) {
        // console.warn(`⚠️ Note: Model ${modelName} skipped/missing.`);
    }
};

async function initialize() {
    try {
        console.log(`📡 Connecting to Database Host: ${dbConfig.host}`);

        // 1. Pre-flight Check (Raw Connection) WITH SSL
        // TiDB requires SSL even for simple checks
        try {
            const connection = await mysql.createConnection({
                host: dbConfig.host, 
                port: dbConfig.port, 
                user: dbConfig.user, 
                password: dbConfig.password,
                connectTimeout: 20000,
                ssl: tidbSSL // 👈 Added SSL here too
            });

            // TiDB Serverless creates DB automatically or restricts CREATE access.
            // We just check if we can connect.
            await connection.end();
        } catch (preError) {
            console.warn("⚠️ Pre-flight check warning:", preError.message);
            // Don't exit, let Sequelize try
        }

        // 2. Initialize Sequelize
        const sequelize = new Sequelize(dbConfig.database, dbConfig.user, dbConfig.password, {
            host: dbConfig.host, 
            port: dbConfig.port, 
            dialect: dbConfig.dialect,
            pool: dbConfig.pool, 
            dialectOptions: dbConfig.dialectOptions, 
            define: {
                charset: 'utf8mb4',
                collate: 'utf8mb4_unicode_ci',
                timestamps: true
            },
            logging: false, 
            timezone: '+05:30' // IST Timezone
        });

        // 3. Authenticate
        await sequelize.authenticate();
        console.log('🚀 TiDB Database Connection: ESTABLISHED');

        // --- MODEL REGISTRY ---
        // Ensure paths are correct relative to config folder
        loadModel(sequelize, '../models/user.model', 'User');
        loadModel(sequelize, '../models/chatMessage.model', 'ChatMessage');
        loadModel(sequelize, '../models/VoiceResponse', 'VoiceResponse');
        loadModel(sequelize, '../models/FAQ', 'FAQ');
        loadModel(sequelize, '../models/DailyReport.model', 'DailyReport');
        loadModel(sequelize, '../models/leaderVideo.model', 'LeaderVideo');
        loadModel(sequelize, '../models/productVideo.model', 'ProductVideo');
        loadModel(sequelize, '../models/subscriber.model', 'Subscriber'); 
        loadModel(sequelize, '../models/Payment', 'Payment');

        // Associations (Relationships)
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

        // 🛡️ SYNC STRATEGY
        console.log("⏳ Syncing Models...");
        try {
            await sequelize.sync({ alter: true });
            console.log(`✅ System Online & Models Synced.`);
        } catch (syncErr) {
            console.warn("⚠️ Sync Warning: Could not alter table automatically.");
            console.warn("   Reason:", syncErr.message);
        }

    } catch (error) {
        console.error('🔥 FATAL DB ERROR:', error.original ? error.original.message : error.message);
        // Important: Throw error so server.js knows db failed
        throw error;
    }
}

module.exports = { db, initialize };