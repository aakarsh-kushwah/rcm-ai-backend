/**
 * @file src/config/db.js
 * @description Titan Hyper-Scale DB: Optimized for Oracle 24GB & TiDB Cloud
 */

require('dotenv').config();
const { Sequelize } = require('sequelize');

// Priority: Use DB_HOST from .env as TiDB Cloud address
const DB_HOST = process.env.DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com';
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME || 'test';
const DB_PORT = process.env.DB_PORT || 4000;

const isProduction = process.env.NODE_ENV === 'production';

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASS, {
    host: DB_HOST,
    port: DB_PORT,
    dialect: 'mysql',
    
    pool: {
        max: isProduction ? 50 : 10, // 24GB RAM can handle 50+ paths
        min: 5,
        acquire: 60000, 
        idle: 10000, 
    },

    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2'
        },
        enableKeepAlive: true, 
        connectTimeout: 60000, 
    },

    logging: console.log, // Log all SQL queries

    benchmark: true,      
    timezone: '+05:30',   

    define: {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        timestamps: true,
        underscored: false // Pro-Standard: created_at instead of createdAt
    },
});

// Guardian Function
const connectDB = async () => {
    try {
        await sequelize.authenticate();
        console.log('✅ [TITAN-DB] Hyper-Scale Connection Established.');
    } catch (err) {
        console.error('❌ [TITAN-DB] Connection Failed:', err.message);
        process.exit(1);
    }
};

module.exports = { sequelize, Sequelize, connectDB };