require('dotenv').config();
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

// --- CONFIGURATION LOAD ---
let fileConfig = {};
try { fileConfig = require('./config.json'); } catch (e) { /* Ignore */ }

const db = {};

// ⚙️ ENTERPRISE DATABASE CONFIGURATION
const dbConfig = {
    host: process.env.DB_HOST || fileConfig.database?.host || '127.0.0.1',
    user: process.env.DB_USER || fileConfig.database?.user || 'root',
    password: process.env.DB_PASSWORD || fileConfig.database?.password || '',
    database: process.env.DB_NAME || fileConfig.database?.database || 'rcm_db',
    port: process.env.DB_PORT || fileConfig.database?.port || 3306,
    dialect: 'mysql',
    
    // 🌊 CONNECTION POOLING (High Traffic Optimization)
    pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 20,
        min: 2,
        acquire: 60000,
        idle: 10000
    },
    
    dialectOptions: {
        decimalNumbers: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000,
    },
    
    logging: false
};

async function initialize() {
    try {
        console.log(`📡 Initializing Database Connection to: ${dbConfig.host}`);

        // 1. PRE-FLIGHT CHECK
        const connection = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password
        });
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        // 2. SEQUELIZE INSTANCE
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
                timezone: '+00:00',
            }
        );

        // 3. HEALTH CHECK
        await sequelize.authenticate();
        console.log('🚀 Database Connection: ESTABLISHED (Pool Ready)');

        // 4. MODEL REGISTRY
        db.User = require('../models/user.model')(sequelize);
        db.ChatMessage = require('../models/chatMessage.model')(sequelize);
        db.Subscriber = require('../models/subscriber.model')(sequelize);
        db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
        db.ProductVideo = require('../models/productVideo.model')(sequelize);
        db.DailyReport = require('../models/DailyReport.model')(sequelize);

        // 5. ASSOCIATIONS
        Object.keys(db).forEach(modelName => {
            if (db[modelName].associate) {
                db[modelName].associate(db);
            }
        });
        
        // Manual Associations (Legacy Safety)
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // =========================================================
        // 🛡️ SELF-HEALING & CLEANUP PROTOCOLS
        // =========================================================
        console.log("🛠️  Running Maintenance Protocols...");

        // A. Disable Constraints (Allow cleanup)
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');

        try {
            // B. Cleanup Orphan Daily Reports
            // (Delete reports where the user no longer exists)
            await sequelize.query(`
                DELETE FROM dailyReports 
                WHERE user_id IS NOT NULL 
                AND user_id NOT IN (SELECT id FROM users)
            `);
            console.log("   - Cleaned orphan Daily Reports");

            // C. Cleanup Orphan Chat Messages (The cause of your error)
            // (Delete messages where the user no longer exists)
            // We use 'chat_messages' because that is the table name in your error log
            await sequelize.query(`
                DELETE FROM chat_messages 
                WHERE userId IS NOT NULL 
                AND userId NOT IN (SELECT id FROM users)
            `);
            console.log("   - Cleaned orphan Chat Messages");

        } catch (cleanupError) {
            console.warn("   ⚠️ Cleanup Warning (Tables might differ):", cleanupError.message);
        }

        // D. Sync Schema
        // Now that bad data is gone, 'alter: true' will succeed
        await sequelize.sync({ alter: true });

        // E. Re-enable Constraints
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

        console.log(`✅ System Online: Database is synchronized and ready for traffic.`);

    } catch (error) {
        console.error('🔥 FATAL SYSTEM ERROR: Database Initialization Failed');
        console.error(error);
        process.exit(1); 
    }
}

module.exports = { db, initialize };