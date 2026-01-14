/**
 * @file db.js
 * @description Hyper-Scale Database Engine (TiDB Optimized)
 * @target Capacity: High Throughput / Low Latency
 */

require('dotenv').config();
const { Sequelize } = require('sequelize');
const fs = require('fs');
const path = require('path');
const os = require('os'); // CPU cores count karne ke liye

// 1. 🛡️ Config Loader
let fileConfig = {};
try { fileConfig = require('../config.json'); } catch (e) { }

// 2. 🔐 TiDB & SSL Configuration
const tidbSSL = {
    require: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
};

const DB_HOST = process.env.DB_HOST || fileConfig.database?.host;
const DB_USER = process.env.DB_USER || fileConfig.database?.user;
const DB_PASS = process.env.DB_PASSWORD || fileConfig.database?.password;
const DB_NAME = process.env.DB_NAME || 'rcm_db';
const DB_PORT = process.env.DB_PORT || 4000;

// 🧠 SMART POOL CALCULATION
// Node.js single threaded hai. Agar aapke server par 4 vCPU hain, 
// to bahut zyada connections open karne se performance gir jayegi.
// Rule: (CPU Cores * 2) + Systematic buffer
const CPU_CORES = os.cpus().length;
const POOL_MAX = process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX) : (CPU_CORES * 5) + 10; 

// 🚀 REPLICATION (Read/Write Splitting)
const REPLICATION_CONFIG = {
    read: [
        { host: process.env.DB_READ_HOST_1 || DB_HOST, username: DB_USER, password: DB_PASS },
        // TiDB automatically load balance karta hai, lekin agar aapke paas
        // specific read-only nodes hain, unhe yahan list karein.
    ],
    write: { host: DB_HOST, username: DB_USER, password: DB_PASS }
};

const dbConfig = {
    dialect: 'mysql', // TiDB is MySQL compatible
    port: DB_PORT,
    
    // 🌊 TITAN POOLING (Optimized for Stability under Load)
    pool: {
        max: POOL_MAX, 
        min: 10,       // Hamesha 10 connection ready rakho (Warm pool)
        acquire: 15000, // Agar 15s me connection na mile, to error do (Queue mat banne do)
        idle: 10000,    // 10s free rahe to connection kaat do
        evict: 5000     
    },

    dialectOptions: {
        decimalNumbers: true,
        connectTimeout: 10000, // Fast fail
        charset: 'utf8mb4',
        ssl: tidbSSL,
        
        // ⚡ CRITICAL PERFORMANCE FLAGS FOR TiDB
        compress: true,       // Network latency kam karega
        dateStrings: true,    
        typeCast: true,
        flags: '-FOUND_ROWS', 
        multipleStatements: false // Security & Speed ke liye false rakhein
    },

    timezone: '+05:30',
    benchmark: false, // Production me Benchmark band rakhein (CPU bachane ke liye)
    logging: false    // ⚠️ ABSOLUTELY ZERO LOGGING for Maximum Speed
};

const db = {};
let sequelize;

// 4. 🧠 Initialize Sequelize
sequelize = new Sequelize(DB_NAME, null, null, {
    replication: REPLICATION_CONFIG,
    dialect: dbConfig.dialect,
    pool: dbConfig.pool,
    dialectOptions: dbConfig.dialectOptions,
    timezone: dbConfig.timezone,
    logging: dbConfig.logging,
    
    // Query Parsing Optimization
    query: { raw: true }, // 🚀 Raw queries are faster (Sequelize models wrap data, which is slow)
    
    define: {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        timestamps: true,
        underscored: false
    }
});

// 5. 🔄 Auto-Discovery (Standard)
const modelsPath = path.join(__dirname, '../models');
if (fs.existsSync(modelsPath)) {
    fs.readdirSync(modelsPath)
        .filter(file => file.endsWith('.js') && file.indexOf('.test.js') === -1)
        .forEach(file => {
            try {
                const modelDef = require(path.join(modelsPath, file));
                const model = typeof modelDef === 'function' ? modelDef(sequelize, Sequelize.DataTypes) : modelDef;
                if (model?.name) db[model.name] = model;
            } catch (err) { console.error(`❌ Model Error: ${file}`, err.message); }
        });
}

Object.keys(db).forEach(modelName => {
    if (db[modelName].associate) db[modelName].associate(db);
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

// 🛡️ CONNECTION HANDLER
const connectDB = async () => {
    try {
        await sequelize.authenticate();
        console.log(`✅ Database Connected. Pool Size: ${POOL_MAX}`);
    } catch (err) {
        console.error("🔥 DB Connection Failed:", err.message);
        process.exit(1); // Kubernetes/Docker will restart it
    }
};

module.exports = { db, connectDB };