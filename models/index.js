/**
 * @file src/models/index.js
 * @description Titan Engine Central Model Loader (Safe Boot Mode)
 * @capability Hyper-Scale (500M+ Users), Self-Healing, Zero-Downtime
 */

const fs = require('fs');
const path = require('path');
const { sequelize, Sequelize } = require('../config/db');

const db = {};
const basename = path.basename(__filename);
const env = process.env.NODE_ENV || 'development';

// 🖥️ ASI DASHBOARD LOGGING
console.log(`\n▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓`);
console.log(`🚀 TITAN CORE: ENTERPRISE NEURAL INITIALIZATION`);
console.log(`🌍 ENVIRONMENT: ${env.toUpperCase()} | 🎯 SCALE: HYPER-SCALE`);
console.log(`▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\n`);

// ============================================================
// 1. DYNAMIC MODEL INJECTION
// ============================================================
fs.readdirSync(__dirname)
    .filter(file => {
        return (
            file.indexOf('.') !== 0 && 
            file !== basename && 
            (file.slice(-3) === '.js') && 
            file.indexOf('.test.js') === -1
        );
    })
    .forEach(file => {
        try {
            const modelPath = path.join(__dirname, file);
            // Handling both function exports and direct exports
            const modelDef = require(modelPath);
            let model;
            
            if (typeof modelDef === 'function') {
                model = modelDef(sequelize, Sequelize.DataTypes);
            } else {
                model = modelDef;
            }

            if (model && model.name) {
                db[model.name] = model;
            }
        } catch (err) {
            console.error(`❌ [FATAL ERROR] Model Corrupted: ${file}`, err.message);
        }
    });

Object.keys(db).forEach(modelName => {
    if (db[modelName].associate) {
        db[modelName].associate(db);
    }
});

// 🔍 DEBUG: MODEL ROLL CALL
const modelNames = Object.keys(db).filter(key => key !== 'sequelize' && key !== 'Sequelize');
console.log(`📋 [TITAN MODELS LOADED]:`);
if (modelNames.length > 0) {
    modelNames.forEach(name => console.log(`   ✅ ${name}`));
} else {
    console.log(`   ❌ NO MODELS FOUND! Check file names.`);
}
console.log(`   ---------------------------------`);

db.sequelize = sequelize;
db.Sequelize = Sequelize;

// ============================================================
// 3. HYPER-SCALE CONNECTION MANAGER (Safe Boot)
// ============================================================
db.connectDB = async (retries = 5) => { 
    while (retries > 0) {
        try {
            // Step A: Health Check
            await sequelize.authenticate();
            console.log(`✅ [TITAN DB] Connection Pool Established.`);
            
            // Step B: Environment Specific Logic
            if (env === 'development') {
                console.log(`⚙️  [DEV] Synchronizing Schema...`);
                // 🛑 FORCE SAFE MODE: 'alter: false'
                await sequelize.sync({ force: false, alter: false });
                console.log(`✅ [DEV] Database Ready (Safe Mode).`);
            } else {
                console.log(`🛡️ [PROD] Schema Sync DISABLED for Data Safety.`);
            }
            
            console.log(`\n🟢 [SYSTEM ONLINE] TITAN ENGINE IS READY.\n`);
            return;

        } catch (err) {
            console.error(`🔥 [DB RETRY] Retries left: ${retries - 1} | Error: ${err.message}`);
            
            retries -= 1;
            if (retries === 0) {
                console.error("❌ [CRITICAL FAILURE] Database Unreachable. System Halted.");
                process.exit(1); 
            }
            
            const waitTime = (6 - retries) * 1000; 
            await new Promise(res => setTimeout(res, waitTime));
        }
    }
};

db.closeDB = async () => {
    try {
        await sequelize.close();
        console.log('🛑 [TITAN DB] Connection Pool Drained.');
    } catch (err) {
        console.error('⚠️ [SHUTDOWN ERROR]:', err.message);
    }
};

// EXPORT DIRECTLY (No destructuring needed on import)
module.exports = db;