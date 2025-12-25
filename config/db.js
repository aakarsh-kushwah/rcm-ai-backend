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
    
    // 🛡️ ULTRA-STABLE POOL SETTINGS
    pool: {
        max: 5,
        min: 0,
        acquire: 120000,
        idle: 20000
    },
    
    // ⚡ NETWORK RESILIENCE & EMOJI SUPPORT
    dialectOptions: {
        decimalNumbers: true, 
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        charset: 'utf8mb4',
    },
    
    logging: false 
};

async function initialize() {
    try {
        console.log(`📡 Connecting to Database Host: ${dbConfig.host}`);

        // 1. Pre-flight Check (Raw Connection)
        const connection = await mysql.createConnection({
            host: dbConfig.host, 
            port: dbConfig.port, 
            user: dbConfig.user, 
            password: dbConfig.password,
            connectTimeout: 60000
        });

        // Create DB with utf8mb4 support explicitly if not exists
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
            logging: (msg) => {
                if (msg.includes('ALTER') || msg.includes('CREATE')) console.log(msg);
            }, 
            timezone: '+00:00'
        });

        // 3. Authenticate
        await sequelize.authenticate();
        console.log('🚀 Database Connection: ESTABLISHED');

        // --- MODEL REGISTRY ---
        // ✅ Make sure these paths match your actual file names
        db.User = require('../models/user.model')(sequelize);
        db.ChatMessage = require('../models/chatMessage.model')(sequelize);
        db.VoiceResponse = require('../models/VoiceResponse')(sequelize);
        db.FAQ = require('../models/FAQ')(sequelize);
        db.DailyReport = require('../models/DailyReport.model')(sequelize); 
        db.LeaderVideo = require('../models/leaderVideo.model')(sequelize); 
        db.ProductVideo = require('../models/productVideo.model')(sequelize);

        // 🔥 FIX: REGISTER THE SUBSCRIBER MODEL HERE
        // (Ensure the filename matches exactly what you named the file in the models folder)
        db.Subscriber = require('../models/subscriber.model')(sequelize); 

        // Associations (Relationships)
        Object.keys(db).forEach(modelName => {
            if (db[modelName].associate) db[modelName].associate(db);
        });
        
        // Define relations
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        if(db.DailyReport && db.User) {
             db.User.hasMany(db.DailyReport, { foreignKey: 'user_id' });
             db.DailyReport.belongsTo(db.User, { foreignKey: 'user_id' });
        }

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // 🛡️ SYNC STRATEGY:
        console.log("⏳ Syncing Models...");
        try {
            await sequelize.sync({ alter: true });
            console.log(`✅ System Online & Models Synced.`);

            // 4. Auto-Repair Script
            await sequelize.query(`ALTER DATABASE \`${dbConfig.database}\` CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;`);
            
            // Add 'subscribers' to the fix list
            const tablesToFix = [
                'faqs', 'voice_responses', 'chat_messages', 
                'leader_videos', 'product_videos', 'subscribers' 
            ];

            for (const table of tablesToFix) {
                try {
                    await sequelize.query(`ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
                } catch(e) {
                    // Ignore error if table doesn't exist yet
                }
            }
            
        } catch (syncErr) {
            console.warn("⚠️ Sync Warning: Could not alter table automatically.");
            console.warn("   Reason:", syncErr.message);
        }

    } catch (error) {
        console.error('🔥 FATAL DB ERROR:', error.original ? error.original.message : error.message);
        process.exit(1); 
    }
}

module.exports = { db, initialize };