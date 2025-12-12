require('dotenv').config();
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

let fileConfig = {};
try { fileConfig = require('./config.json'); } catch (e) { }

const db = {};

const dbConfig = {
    host: process.env.DB_HOST || fileConfig.database?.host || '127.0.0.1',
    user: process.env.DB_USER || fileConfig.database?.user || 'root',
    password: process.env.DB_PASSWORD || fileConfig.database?.password || '',
    database: process.env.DB_NAME || fileConfig.database?.database || 'rcm_db',
    port: process.env.DB_PORT || fileConfig.database?.port || 3306,
    dialect: 'mysql',
    
    pool: {
        max: 5,
        min: 0,
        acquire: 120000,
        idle: 20000
    },
    
    dialectOptions: {
        decimalNumbers: true, 
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000, 
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        charset: 'utf8mb4', // ✅ Connection charset
    },
    
    logging: false 
};

async function initialize() {
    try {
        console.log(`📡 Connecting to Database Host: ${dbConfig.host}`);

        // 1. Pre-flight: Ensure DB exists with correct Charset
        const connection = await mysql.createConnection({
            host: dbConfig.host, 
            port: dbConfig.port, 
            user: dbConfig.user, 
            password: dbConfig.password,
            connectTimeout: 60000
        });

        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
        await connection.end();

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
            timezone: '+00:00'
        });

        await sequelize.authenticate();
        console.log('🚀 Database Connection: ESTABLISHED');

        // --- MODEL REGISTRY ---
        db.User = require('../models/user.model')(sequelize);
        db.ChatMessage = require('../models/chatMessage.model')(sequelize);
        db.VoiceResponse = require('../models/VoiceResponse')(sequelize);
        db.FAQ = require('../models/FAQ')(sequelize);

        Object.keys(db).forEach(modelName => {
            if (db[modelName].associate) db[modelName].associate(db);
        });
        
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // 3. Sync Models
        console.log("⏳ Syncing Models...");
        await sequelize.sync({ alter: true });
        console.log(`✅ Models Synced.`);

        // 4. 🛠️ AUTO-REPAIR SCRIPT (The Fix for your Error)
        // Ye script check karegi aur tables ko force-convert karegi
        console.log("🔧 Running Auto-Repair for Emojis...");
        try {
            await sequelize.query(`ALTER DATABASE \`${dbConfig.database}\` CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;`);
            await sequelize.query(`ALTER TABLE faqs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
            await sequelize.query(`ALTER TABLE voice_responses CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
            await sequelize.query(`ALTER TABLE chat_messages CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
            console.log("✨ Tables successfully upgraded to support Emojis!");
        } catch (repairErr) {
            // Agar table nahi bani hogi to error aayega, ignore it
            console.log("ℹ️ Auto-repair skipped (Tables might be fresh).");
        }

    } catch (error) {
        console.error('🔥 FATAL DB ERROR:', error.original ? error.original.message : error.message);
        process.exit(1); 
    }
}

module.exports = { db, initialize };