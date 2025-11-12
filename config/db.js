const config = require('./config.json');
const mysql = require('mysql2/promise');
const { Sequelize } = require('sequelize');

const db = {};

async function initialize() {
  // ⭐️ 'sequelize' ko bahar define karein taaki 'catch' block mein use ho sake
  const { host, port, user, password, database } = config.database;
  let sequelize; 

  try {
    const connection = await mysql.createConnection({ host, port, user, password });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\`;`);
    await connection.end();
    console.log('✅ Database checked/created successfully.');

    // ⭐️ 'sequelize' ko assign karein
    sequelize = new Sequelize(database, user, password, {
      host,
      port,
      dialect: 'mysql',
      logging: false, 
      pool: { max: 3, min: 0, acquire: 30000, idle: 10000 }
    });

    await sequelize.authenticate();
    console.log('✅ Connection to database established successfully.');

    // Load models
    db.User = require('../models/user.model')(sequelize);
    db.ChatMessage = require('../models/chatMessage.model')(sequelize);
    db.Subscriber = require('../models/subscriber.model')(sequelize);
    db.LeaderVideo = require('../models/leaderVideo.model')(sequelize);
    db.ProductVideo = require('../models/productVideo.model')(sequelize);

    // Define associations
    db.User.hasMany(db.ChatMessage, { foreignKey: 'userId', as: 'chatMessages' });
    db.ChatMessage.belongsTo(db.User, { foreignKey: 'userId', as: 'User' });

    db.Sequelize = Sequelize;
    db.sequelize = sequelize;

    // --- 👇 YEH BADLAAV KIYA GAYA HAI (TRANSACTION) ---
    
    // Ek transaction start karein taaki sabhi command ek hi connection par chalen
    const transaction = await sequelize.transaction();
    console.log('Transaction started...');
    
    try {
        // Step 1: Foreign key checks ko is transaction ke liye disable karein
        console.log('Disabling foreign key checks for this transaction...');
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 0;', { transaction });

        // Step 2: Database ko sync karein (isi transaction mein)
        await sequelize.sync({ alter: true, transaction }); 
        console.log('✅ All models were synchronized successfully (Alter Mode).');
        
        // Step 3: Transaction ko commit karein (changes save karein)
        await transaction.commit();
        console.log('Transaction committed.');

    } catch (error) {
        // Agar sync ke dauraan error aaye, toh transaction ko rollback karein
        console.error('❌ Error during sync, rolling back transaction...');
        await transaction.rollback();
        throw error; // Error ko neeche 'catch' block mein bhejें
    } finally {
        // Step 4: Foreign key checks ko hamesha waapas chalu karein (global)
        // Yeh transaction ke bahar bhi chalega, jo zaroori hai
        console.log('Re-enabling foreign key checks globally...');
        await sequelize.query('SET FOREIGN_KEY_CHECKS = 1;');
    }
    
    // --- 👆 YEH BADLAAV KIYA GAYA HAI ---

  } catch (error) {
    console.error('❌ Unable to initialize the database:', error);
    // Agar 'initialize' mein error aaya ho, toh 'sequelize' define nahin hoga
    if (sequelize) {
        try {
            // Har haal mein checks ko on karein
            await sequelize.query('SET FOREIGN_KEY_CHECKS = 1;');
            console.log('Restored foreign key checks after error.');
        } catch (e) {
            console.error('Could not restore foreign key checks:', e);
        }
    }
    throw error;
  }
}

module.exports = { db, initialize };