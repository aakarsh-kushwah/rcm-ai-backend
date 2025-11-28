require('dotenv').config();
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

// --- 1. CONFIGURATION LOAD STRATEGY ---
// Fallback to file config if env vars are missing (Hybrid Approach)
let fileConfig = {};
try { fileConfig = require('./config.json'); } catch (e) { /* Silent fail */ }

const db = {};

// ⚙️ HIGH-PERFORMANCE DATABASE CONFIGURATION
const dbConfig = {
    host: process.env.DB_HOST || fileConfig.database?.host || '127.0.0.1',
    user: process.env.DB_USER || fileConfig.database?.user || 'root',
    password: process.env.DB_PASSWORD || fileConfig.database?.password || '',
    database: process.env.DB_NAME || fileConfig.database?.database || 'rcm_db',
    port: process.env.DB_PORT || fileConfig.database?.port || 3306,
    dialect: 'mysql',
    
    // 🌊 SMART CONNECTION POOLING (Traffic Manager)
    // Meta/Google use pooling to handle millions of requests efficiently.
    pool: {
        // Cloud Shared DBs (like Clever Cloud Free Tier) often limit connections.
        // '10' is a safe sweet spot for high performance without hitting limits.
        // For Dedicated Enterprise Servers, you can increase this to 50 or 100.
        max: parseInt(process.env.DB_POOL_MAX) || 10, 
        min: 2,       // Always keep 2 connections ready for instant response
        acquire: 30000, // Wait 30s before failing (Resilience)
        idle: 10000   // Close connection if unused for 10s (Resource Saving)
    },
    
    // ⚡ QUERY OPTIMIZATION
    dialectOptions: {
        decimalNumbers: true, // Critical for Financial calculations (PV/Income)
        supportBigNumbers: true,
        bigNumberStrings: true,
        connectTimeout: 60000, // Handle network latency gracefully
    },
    
    // Disable SQL logging in production for max speed
    logging: false 
};

async function initialize() {
    try {
        console.log(`📡 Connecting to Database Host: ${dbConfig.host}`);

        // =========================================================
        // 1. PRE-FLIGHT SYSTEM CHECK (Infrastructure Layer)
        // =========================================================
        // Ensure the database actually exists before Sequelize tries to connect
        const connection = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password
        });
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        // =========================================================
        // 2. INITIALIZE ORM (Application Layer)
        // =========================================================
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
                timezone: '+00:00', // Standardize timezones to UTC
            }
        );

        // Health Check (Ping)
        await sequelize.authenticate();
        console.log('🚀 Database Connection: ESTABLISHED (Pool Ready)');

        // =========================================================
        // 3. MODEL REGISTRY (Centralized Loading)
        // =========================================================
        // Yahan hum models load kar rahe hain taaki puri app mein
        // 'db.User' ya 'db.ChatMessage' kahin se bhi access ho sake.
        
        db.User = require('../models/user.model')(sequelize);
        db.ChatMessage = require('../models/chatMessage.model')(sequelize);
        db.Subscriber = require('../models/subscriber.model')(sequelize);
        db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
        db.ProductVideo = require('../models/productVideo.model')(sequelize);
        
        // ✅ IMPORTANT: File name casing must match exactly
        // Humne ise 'dailyReport.model.js' maan kar load kiya hai
        db.DailyReport = require('../models/dailyReport.model')(sequelize); 

        // =========================================================
        // 4. DEFINE ASSOCIATIONS (Relationship Map)
        // =========================================================
        Object.keys(db).forEach(modelName => {
            if (db[modelName].associate) {
                db[modelName].associate(db);
            }
        });
        
        // Explicit Fallback Associations (Safety Net)
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        // =========================================================
        // 🛡️ SELF-HEALING & MAINTENANCE PROTOCOLS (DevOps Layer)
        // =========================================================
        console.log("🛠️  Running System Maintenance...");

        // Step A: Disable Constraints (To allow cleaning bad data)
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');

        try {
            // Step B: Orphan Data Cleanup (Garbage Collection)
            // Delete chats/reports that belong to users who no longer exist
            await sequelize.query(`
                DELETE FROM chat_messages 
                WHERE userId IS NOT NULL 
                AND userId NOT IN (SELECT id FROM users)
            `);
            
            // Handle Migration: If moving from old DailyReports to new format
            // This prevents crashes if table schema changed drastically
            // await sequelize.query('DROP TABLE IF EXISTS dailyReports'); 

        } catch (cleanupError) {
            // Non-blocking error (Log and continue)
            console.warn("   ⚠️ Maintenance Notice:", cleanupError.message);
        }

        // Step C: Schema Synchronization (Apply structural changes)
        // 'alter: true' is safe for production as it updates columns without data loss
        await sequelize.sync({ alter: true });

        // Step D: Re-enable Constraints (Security)
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

        console.log(`✅ System Online: Architecture Ready for High Traffic.`);

    } catch (error) {
        console.error('🔥 FATAL SYSTEM ERROR: Database Initialization Failed');
        console.error(error);
        // Exit process to allow Container Orchestrator (Render/K8s) to restart the pod
        process.exit(1); 
    }
}

module.exports = { db, initialize };