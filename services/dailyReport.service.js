const { db } = require('../config/db'); // Import DB
const { Op } = require('sequelize');

module.exports = {
    postDailyReport,
    getDailyReport
};

async function postDailyReport(params, userId) {
    try {
        const entries = Array.isArray(params) ? params : [params];
        const results = [];

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;

            const { date, amount } = entry;

            // Validation
            if (!date || amount === null || amount === undefined || isNaN(Number(amount))) {
                console.warn("Skipping invalid entry:", entry);
                continue;
            }

            // Upsert: Create if not exists, Update if exists
            const [report, created] = await db.DailyReport.upsert({
                user_id: userId,
                date,
                amount: Number(amount)
            });

            results.push({ date, amount, status: created ? 'created' : 'updated' });
        }

        return results;
    } catch (error) {
        console.error("Error in postDailyReport service:", error);
        throw new Error(`Error saving daily report: ${error.message || error}`);
    }
}

async function getDailyReport(params, userId) {
    try {
        let { month, year } = params;

        if (!month || !year) {
            throw new Error("Month and year are required to fetch the daily report.");
        }

        // Ensure month is 2-digit
        month = month.toString().padStart(2, '0');

        const startDate = new Date(`${year}-${month}-01`);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1);
        endDate.setDate(0); // last day of the month

        const reports = await db.DailyReport.findAll({
            where: {
                user_id: userId,
                date: {
                    [Op.between]: [
                        startDate.toISOString().slice(0, 10),
                        endDate.toISOString().slice(0, 10)
                    ]
                }
            },
            attributes: ['date', 'amount', 'createdAt', 'updatedAt'],
            order: [['date', 'ASC']]
        });

        return reports.map(r => r.get({ plain: true }));
    } catch (error) {
        console.error("Error in getDailyReport service:", error);
        throw new Error(`Error fetching daily report: ${error.message || error}`);
    }
}