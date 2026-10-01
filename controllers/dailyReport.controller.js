const service = require('../services/dailyReport.service');

const responseHandler = (res, message, status, data = null) => {
    return res.status(status ? 200 : 400).json({
        status,
        message,
        data
    });
};

async function postDailyReport(req, res, next) {
    try {
        // 🔍 DEBUGGING LOGS
        console.log("📥 Incoming Report Data:", JSON.stringify(req.body, null, 2));
        console.log("👤 User ID from Token:", req.userId);

        if (!req.userId) {
            throw new Error("User ID is missing from Token. Please Logout & Login again.");
        }

        const result = await service.postDailyReport(req.body, req.userId);
        responseHandler(res, "Daily report saved successfully!", true, result);
    } catch (err) {
        console.error("🔥 Error Saving Report:", err.message); // Console mein error dikhega
        responseHandler(res, `Error: ${err.message}`, false);
    }
}

async function getDailyReport(req, res, next) {
    try {
        console.log("📥 Fetching Report for:", req.body);
        const result = await service.getDailyReport(req.body, req.userId);
        responseHandler(res, "Daily report retrieved successfully!", true, result);
    } catch (err) {
        console.error("🔥 Error Fetching Report:", err.message);
        responseHandler(res, `Error: ${err.message}`, false);
    }
}

module.exports = {
    postDailyReport,
    getDailyReport
};