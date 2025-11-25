require('dotenv').config();
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

// --- CONFIGURATION LOAD ---
let fileConfig = {};
try { fileConfig = require('./config.json'); } catch (e) { /* Ignore */ }

const db = {};

// ⚙️ ENTERPRISE DATABASE CONFIGURATION (AWS/Render Ready)
const dbConfig = {
    host: process.env.DB_HOST || fileConfig.database?.host || '127.0.0.1',
    user: process.env.DB_USER || fileConfig.database?.user || 'root',
    password: process.env.DB_PASSWORD || fileConfig.database?.password || '',
    database: process.env.DB_NAME || fileConfig.database?.database || 'rcm_db',
    port: process.env.DB_PORT || fileConfig.database?.port || 3306,
    dialect: 'mysql',
    
    // 🌊 CONNECTION POOLING (High Traffic Handler)
    pool: {
        max: parseInt(process.env.DB_POOL_MAX) || 20, // 20 Active Connections
        min: 2,
        acquire: 60000,
        idle: 10000
    },
    
    dialectOptions: {
        decimalNumbers: true, // For precise PV calculations
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000,
    },
    
    logging: false // Production mode: Silent logs for speed
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
        db.DailyReport = require('../models/DailyReport.model')(sequelize); // Ensure this model file is updated to JSON logic

        // 5. ASSOCIATIONS
        Object.keys(db).forEach(modelName => {
            if (db[modelName].associate) {
                db[modelName].associate(db);
            }
        });
        
        // Manual Associations (Safety Net)
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // =========================================================
        // 🛡️ SELF-HEALING & MIGRATION PROTOCOLS
        // =========================================================
        console.log("🛠️  Running Maintenance Protocols...");

        // A. Disable Constraints (To allow restructuring)
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');

        try {
            // B. ORPHAN DATA CLEANUP
            console.log("   - Cleaning orphan Chat Messages...");
            await sequelize.query(`
                DELETE FROM chat_messages 
                WHERE userId IS NOT NULL 
                AND userId NOT IN (SELECT id FROM users)
            `);

            // C. MIGRATION: DROP OLD TABLE (Critical for new Architecture)
            // Kyunki humne structure Row-based se JSON-based kar diya hai,
            // purani table 'dailyReports' ko hatana zaroori hai taki conflict na ho.
            // Nayi table ka naam humne Model me 'monthly_reports' rakha hai.
            console.log("   - Migrating Legacy Tables...");
            await sequelize.query('DROP TABLE IF EXISTS dailyReports');

        } catch (cleanupError) {
            console.warn("   ⚠️ Maintenance Warning (Safe to ignore):", cleanupError.message);
        }

        // D. SYNC SCHEMA (Create new tables)
        await sequelize.sync({ alter: true });

        // E. Re-enable Constraints
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

        console.log(`✅ System Online: Scalable Architecture Ready.`);

    } catch (error) {
        console.error('🔥 FATAL SYSTEM ERROR: Database Initialization Failed');
        console.error(error);
        process.exit(1); 
    }
}

module.exports = { db, initialize };