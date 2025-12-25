const { db } = require('../config/db');

module.exports = {
    postDailyReport,
    getDailyReport
};

async function postDailyReport(params, userId) {
    try {
        const entries = Array.isArray(params) ? params : [params];
        const results = [];

        for (const entry of entries) {
            // Frontend se date "2025-11-24" aayegi
            const fullDate = new Date(entry.date);
            const day = fullDate.getDate().toString(); // "24"
            const month = fullDate.getMonth() + 1;     // 11
            const year = fullDate.getFullYear();       // 2025
            const amount = Number(entry.amount);

            // 1. Check karo ki is mahine ki row exist karti hai ya nahi
            let report = await db.DailyReport.findOne({
                where: { user_id: userId, month, year }
            });

            // 2. Agar nahi hai, to nayi row banao
            if (!report) {
                report = await db.DailyReport.build({
                    user_id: userId,
                    month,
                    year,
                    daily_data: {},
                    monthly_total: 0
                });
            }

            // 3. JSON Data Update karo
            // Purana data copy karo aur naya din add/update karo
            const currentData = { ...report.daily_data };
            currentData[day] = amount;

            // 4. Update JSON & Total
            report.daily_data = currentData;
            
            // Total Recalculate (Cumulative logic jo aapne maanga tha)
            // Aapka logic: Latest date ki value hi total hai.
            // Lekin JSON me hum max value nikalenge ya last entered value.
            
            // Yahan hum latest day dhoondh rahe hain
            const days = Object.keys(currentData).map(d => parseInt(d)).sort((a,b) => b-a);
            const latestDay = days[0];
            report.monthly_total = currentData[latestDay];

            await report.save();
            results.push(report);
        }

        return results;
    } catch (error) {
        throw new Error(`Error saving report: ${error.message}`);
    }
}

async function getDailyReport(params, userId) {
    try {
        const { month, year } = params;

        // Sirf 1 Row fetch karni hai! Super Fast.
        const report = await db.DailyReport.findOne({
            where: { 
                user_id: userId, 
                month: parseInt(month), 
                year: parseInt(year) 
            }
        });

        if (!report) return [];

        // Frontend ko wahi purana format chahiye (Array of objects)
        // To hum JSON ko wapas Array mein convert karke bhejenge
        const formattedData = Object.entries(report.daily_data).map(([day, amount]) => ({
            date: `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
            amount: amount
        }));

        return formattedData;
    } catch (error) {
        throw new Error(`Error fetching report: ${error.message}`);
    }
}