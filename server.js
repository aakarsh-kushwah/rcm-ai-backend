// ज़रूरी पैकेजेज़ इम्पोर्ट करें
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

// ऐप और पोर्ट सेटअप
const app = express();
const PORT = process.env.PORT || 3001;

// मिडिलवेयर
app.use(cors()); // Cross-Origin Resource Sharing को इनेबल करें
app.use(express.json()); // JSON रिक्वेस्ट को समझने के लिए

// डेटाबेस कनेक्शन पूल
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// टेस्ट रूट: यह चेक करने के लिए कि सर्वर चल रहा है
app.get('/', (req, res) => {
    res.send('RCM AI Backend is running!');
});

// API रूट: नया सब्सक्राइबर जोड़ने के लिए
app.post('/api/subscribe', async (req, res) => {
    const { name, phone } = req.body;

    // बेसिक वैलिडेशन
    if (!name || !phone) {
        return res.status(400).json({ success: false, message: 'Name and phone number are required.' });
    }

    try {
        // SQL क्वेरी
        const sql = 'INSERT INTO subscribers (name, phone_number) VALUES (?, ?)';
        
        // डेटाबेस में डेटा डालें
        await dbPool.query(sql, [name, phone]);
        
        console.log(`Data saved: ${name}, ${phone}`);
        res.status(201).json({ success: true, message: 'Successfully subscribed!' });

    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, message: 'Failed to subscribe. Please try again later.' });
    }
});

// सर्वर को शुरू करें
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    // सर्वर स्टार्ट होने पर डेटाबेस टेबल बनाने का प्रयास करें
    createTableIfNotExists();
});

// यह फंक्शन चेक करेगा कि टेबल मौजूद है या नहीं, नहीं तो बना देगा
async function createTableIfNotExists() {
    try {
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS subscribers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone_number VARCHAR(20) NOT NULL,
                subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await dbPool.query(createTableSql);
        console.log('Table "subscribers" is ready.');
    } catch (error) {
        console.error('Could not create table:', error);
    }
}