const pino = require("pino");

const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    base: { service: 'titan-core', env: process.env.NODE_ENV },
    transport: process.env.NODE_ENV !== "production" ? { target: 'pino-pretty' } : undefined
});

module.exports = { logger };
