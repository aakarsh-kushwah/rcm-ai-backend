/**
 * @file src/config/db.js
 * @description Titan Hyper-Scale Database Engine (ASI Edition v3.0)
 * @capabilities Self-Healing, Slow Query Detection, TiDB Optimization
 */

require('dotenv').config();
const { Sequelize } = require('sequelize');
const os = require('os');
const path = require('path');

// ============================================================
// 1. 🧠 SMART CONFIGURATION
// ============================================================
const isProduction = process.env.NODE_ENV === 'production';

const DB_HOST = process.env.TIDB_HOST || process.env.DB_HOST;
const DB_USER = process.env.TIDB_USER || process.env.DB_USER;
const DB_PASS = process.env.TIDB_PASSWORD || process.env.DB_PASSWORD;
const DB_NAME = process.env.TIDB_DB_NAME || process.env.DB_NAME || 'rcm_db';
const DB_PORT = process.env.TIDB_PORT || 4000;

// CPU Smart Calculation for Connection Pool
// TiDB handles connections efficiently.
const CPU_CORES = os.cpus().length;
const MAX_CONNECTIONS = process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX) : (CPU_CORES * 4) + 5;

// ============================================================
// 2. 🛡️ ASI INTELLIGENT LOGGER
// ============================================================
// Queries slower than 800ms trigger a warning.
const smartLogger = (msg, executionTime) => {
    if (executionTime > 800) { 
        console.warn(`⚠️ [SLOW QUERY] ${executionTime}ms: ${msg}`);
    }
};

// ============================================================
// 3. 🚀 SEQUELIZE INSTANCE (The Engine)
// ============================================================
const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
    host: DB_HOST,
    port: DB_PORT,
    dialect: 'mysql', // TiDB is MySQL 5.7 compatible
    
    // 🧠 ASI REPLICATION STRATEGY
    replication: {
        read: [{ host: DB_HOST, username: DB_USER, password: DB_PASS }],
        write: { host: DB_HOST, username: DB_USER, password: DB_PASS }
    },

    // 🌊 TITAN SMART POOLING
    pool: {
        max: MAX_CONNECTIONS,
        min: 2,               // Keep 2 connections always warm
        acquire: 60000,       // (Updated) Wait 60s for TiDB Cloud Latency
        idle: 10000,          // Kill connection if idle for 10s
        
        // ✨ MAGIC VALIDATION (Kept Same - Very Good Logic)
        validate: async (conn) => {
            try {
                if (conn.promise) {
                    await conn.promise().query('SELECT 1');
                } else {
                    await new Promise((resolve, reject) => {
                        conn.query('SELECT 1', (err) => err ? reject(err) : resolve());
                    });
                }
                return true;
            } catch (err) {
                return false;
            }
        }
    },

    dialectOptions: {
        // ✅ FIX: SSL Logic (Production vs Development)
        // Production me SSL compulsory hai, Localhost me optional rakho taaki crash na ho.
        ssl: {
            require: true,
            rejectUnauthorized: isProduction ? true : false, // Dev me certificate ignore karo
            minVersion: 'TLSv1.2'
        },
        // ⚡ HIGH PERFORMANCE FLAGS
        decimalNumbers: true,
        connectTimeout: 60000, // TiDB Cloud can take time
        charset: 'utf8mb4',
        compress: true, // Saves Bandwidth cost on AWS/TiDB Cloud
    },

    logging: isProduction ? smartLogger : console.log, // Dev me sab dikhao, Prod me sirf Errors
    benchmark: true,      // Calculate query execution time
    timezone: '+05:30',   // IST Timezone

    // Global Model Settings
    define: {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        timestamps: true,
        underscored: false,
        freezeTableName: false 
    }
});

module.exports = { sequelize, Sequelize };