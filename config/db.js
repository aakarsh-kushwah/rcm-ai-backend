/**
 * @file src/config/db.js
 * @description Titan Hyper-Scale Database Engine (Fixed Configuration)
 */

require('dotenv').config();
const { Sequelize } = require('sequelize');

// ============================================================
// 1. SMART CONFIGURATION
// ============================================================
const isProduction = process.env.NODE_ENV === 'production';

const DB_HOST = process.env.TIDB_HOST || process.env.DB_HOST;
const DB_USER = process.env.TIDB_USER || process.env.DB_USER;
const DB_PASS = process.env.TIDB_PASSWORD || process.env.DB_PASSWORD;
const DB_NAME = process.env.TIDB_DB_NAME || process.env.DB_NAME || 'rcm_db';
const DB_PORT = process.env.TIDB_PORT || 4000;

// TiDB Cloud Limit Safety
const MAX_CONNECTIONS = isProduction ? 10 : 5; 

// ============================================================
// 2. 🛡️ SEQUELIZE INSTANCE
// ============================================================
const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
    host: DB_HOST,
    port: DB_PORT,
    dialect: 'mysql',
    
    // 🌊 TITAN SMART POOLING
    pool: {
        max: MAX_CONNECTIONS,
        min: 0,
        acquire: 60000, 
        idle: 10000, 
    },

    dialectOptions: {
        // ✅ SSL Logic
        ssl: {
            require: true,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2'
        },
        // ⚡ FIX: 'keepAlive' ki warning hatane ke liye sahi option
        enableKeepAlive: true, 
        connectTimeout: 60000, 
        charset: 'utf8mb4',
    },

    logging: false, 
    benchmark: true,      
    timezone: '+05:30',   

    define: {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        timestamps: true,
        underscored: false,
        freezeTableName: false 
    },
});

module.exports = { sequelize, Sequelize };