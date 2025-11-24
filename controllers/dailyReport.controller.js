const service = require('../services/dailyReport.service');

// Response Handler
const responseHandler = (res, message, status, data = null) => {
    return res.status(status ? 200 : 400).json({
        status,
        message,
        data
    });
};

async function postDailyReport(req, res, next) {
    try {
        const result = await service.postDailyReport(req.body, req.userId);
        responseHandler(res, "Daily report saved successfully!", true, result);
    } catch (err) {
        responseHandler(res, `Error: ${err.message}`, false);
    }
}

async function getDailyReport(req, res, next) {
    try {
        const result = await service.getDailyReport(req.body, req.userId);
        responseHandler(res, "Daily report retrieved successfully!", true, result);
    } catch (err) {
        responseHandler(res, `Error: ${err.message}`, false);
    }
}

// ✅ DHYAAN DEIN: Ye export zaroori hai
module.exports = {
    postDailyReport,
    getDailyReport
};