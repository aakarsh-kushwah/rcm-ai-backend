// ज़रूरी पैकेजेज़ इम्पोर्ट करें
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg'); // ✅ बदला हुआ: pg लाइब्रेरी का Pool इस्तेमाल करें
const cors = require('cors');

// ऐप और पोर्ट सेटअप
const app = express();
const PORT = process.env.PORT || 3001;

// मिडिलवेयर
app.use(cors());
app.use(express.json());

// ✅ बदला हुआ: PostgreSQL का कनेक्शन पूल
// यह Render के DATABASE_URL से सीधे कनेक्ट हो जाएगा
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL, // Render यह URL अपने आप दे देता है
    ssl: {
        rejectUnauthorized: false // Render के SSL कनेक्शन के लिए ज़रूरी
    }
});

// टेस्ट रूट: यह चेक करने के लिए कि सर्वर चल रहा है
app.get('/', (req, res) => {
    res.send('RCM AI Backend is running!');
});

// API रूट: नया सब्सक्राइबर जोड़ने के लिए
app.post('/api/subscribe', async (req, res) => {
    const { name, phone } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ success: false, message: 'Name and phone number are required.' });
    }

    try {
        // ✅ बदला हुआ: SQL क्वेरी में प्लेसहोल्डर (?) की जगह ($1, $2) का इस्तेमाल करें
        const sql = 'INSERT INTO subscribers (name, phone_number) VALUES ($1, $2)';
        
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
        // ✅ बदला हुआ: SQL सिंटैक्स को PostgreSQL के हिसाब से बदला गया
        // INT AUTO_INCREMENT की जगह SERIAL PRIMARY KEY का इस्तेमाल होता है
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS subscribers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone_number VARCHAR(20) NOT NULL,
                subscribed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await dbPool.query(createTableSql);
        console.log('Table "subscribers" is ready.');
    } catch (error) {
        console.error('Could not create table:', error);
    }
}

app.get('/api/subscribers', async (req, res) => {
    try {
        const result = await dbPool.query('SELECT id, name, phone_number, subscribed_at FROM subscribers ORDER BY id DESC');
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch data.' });
    }
});