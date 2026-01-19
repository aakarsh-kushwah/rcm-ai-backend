/**
 * @file src/services/dailyReport.service.js
 * @description Optimized for Bulk Updates (Super Fast)
 */

const db = require('../models'); 
const { DailyReport } = db;

async function postDailyReport(params, userId) {
    try {
        const entries = Array.isArray(params) ? params : [params];
        if (entries.length === 0) return [];

        // Step 1: Data ko Month/Year ke hisab se group karein
        // Taaki agar 2 mahino ka data ek saath aaye to bhi handle ho jaye
        const groups = {};

        entries.forEach(entry => {
            const dateObj = new Date(entry.date);
            const month = dateObj.getMonth() + 1;
            const year = dateObj.getFullYear();
            const day = dateObj.getDate();
            const key = `${year}-${month}`; // Unique Key like "2026-1"

            if (!groups[key]) {
                groups[key] = { month, year, updates: [] };
            }
            groups[key].updates.push({ day, amount: Number(entry.amount) });
        });

        const results = [];

        // Step 2: Har Mahine ke liye sirf EK baar DB call karein
        for (const key in groups) {
            const { month, year, updates } = groups[key];

            // A. Fetch Report ONCE (Ek baar mangvao)
            let report = await DailyReport.findOne({
                where: { user_id: userId, month, year }
            });

            // B. Create if not exists
            if (!report) {
                report = await DailyReport.create({
                    user_id: userId,
                    month,
                    year,
                    daily_data: {},
                    monthly_total: 0
                });
            }

            // C. Update JSON in Memory (Ram ke andar update karo, DB me nahi)
            const currentData = { ...(report.daily_data || {}) };

            updates.forEach(item => {
                currentData[item.day] = item.amount; // Har din ka data update
            });

            // D. Calculate Total (Fast Calculation)
            // JSON ki saari values ko jod lo
            const newTotal = Object.values(currentData).reduce((sum, val) => sum + Number(val), 0);

            // E. Save to DB ONCE (Sirf ek baar save command chalao)
            report.daily_data = currentData;
            report.monthly_total = newTotal;
            
            // Sequelize ko batao ki JSON change hua hai
            report.changed('daily_data', true); 
            
            await report.save();
            results.push(report);
        }

        return results;

    } catch (error) {
        console.error("🔥 Service Error:", error);
        throw new Error(`Error saving report: ${error.message}`);
    }
}

async function getDailyReport(params, userId) {
    try {
        const { month, year } = params;

        const report = await DailyReport.findOne({
            where: { 
                user_id: userId, 
                month: parseInt(month), 
                year: parseInt(year) 
            }
        });

        if (!report) return [];

        // JSON ko wapas List me convert karke bhejo
        const formattedData = Object.entries(report.daily_data || {}).map(([day, amount]) => ({
            date: `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
            amount: amount
        }));

        return formattedData;
    } catch (error) {
        console.error("🔥 Service Error:", error);
        throw new Error(`Error fetching report: ${error.message}`);
    }
}

module.exports = {
    postDailyReport,
    getDailyReport
};