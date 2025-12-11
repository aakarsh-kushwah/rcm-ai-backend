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
    pool: { max: 10, min: 2, acquire: 30000, idle: 10000 },
    dialectOptions: { decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 60000 },
    logging: false 
};

async function initialize() {
    try {
        const connection = await mysql.createConnection({
            host: dbConfig.host, port: dbConfig.port, user: dbConfig.user, password: dbConfig.password
        });
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        const sequelize = new Sequelize(dbConfig.database, dbConfig.user, dbConfig.password, {
            host: dbConfig.host, port: dbConfig.port, dialect: dbConfig.dialect,
            pool: dbConfig.pool, dialectOptions: dbConfig.dialectOptions, logging: dbConfig.logging, timezone: '+00:00'
        });

        await sequelize.authenticate();
        console.log('🚀 Database Connection: ESTABLISHED');

        // --- MODEL REGISTRY ---
        db.User = require('../models/user.model')(sequelize);
        db.ChatMessage = require('../models/chatMessage.model')(sequelize);
        
        // ✅ 1. Voice Cache Model
        db.VoiceResponse = require('../models/VoiceResponse')(sequelize);
        
        // ✅ 2. FAQ Model (For Zero-Cost Question Matching)
        // Ensure you created models/FAQ.js as discussed previously!
        db.FAQ = require('../models/FAQ')(sequelize);

        // Associations
        Object.keys(db).forEach(modelName => {
            if (db[modelName].associate) db[modelName].associate(db);
        });
        
        db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
        db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

        db.Sequelize = Sequelize;
        db.sequelize = sequelize;

        await sequelize.sync({ alter: true });
        console.log(`✅ System Online & Models Synced.`);

    } catch (error) {
        console.error('🔥 FATAL DB ERROR:', error);
        process.exit(1); 
    }
}

module.exports = { db, initialize };