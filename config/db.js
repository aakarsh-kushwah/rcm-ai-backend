/**
 * @file src/config/db.js
 * @description Titan DB: Safe for Local Dev, Render (512MB), and Scalable for Oracle 24GB
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Sequelize } = require('sequelize');

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
        // Explicitly sized for TiDB tier; configurable via environment variables
        max: parseInt(process.env.DB_POOL_MAX, 10) || (isProduction ? 25 : 10),
        min: parseInt(process.env.DB_POOL_MIN, 10) || 0,
        acquire: parseInt(process.env.DB_POOL_ACQUIRE, 10) || 30000,
        idle: parseInt(process.env.DB_POOL_IDLE, 10) || 10000,
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

    // 💥 SABSE BADA FIX: SQL logging ko false karein taaki terminal buffer leak band ho
    logging: false, 

    benchmark: false,      
    timezone: '+05:30',   

    define: {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        timestamps: true,
        underscored: false
    },
});

// Guardian Function
const connectDB = async () => {
    try {
        await sequelize.authenticate();
        console.log('✅ [TITAN-DB] Connection Established Successfully.');
    } catch (err) {
        console.error('❌ [TITAN-DB] Connection Failed:', err.message);
        process.exit(1);
    }
};

module.exports = { sequelize, Sequelize, connectDB };