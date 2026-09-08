const pino = require("pino");

const logger = pino({
    level: process.env.LOG_LEVEL || "info",
    base: { service: 'titan-core', env: process.env.NODE_ENV },
    transport: process.env.NODE_ENV !== "production" ? { target: 'pino-pretty' } : undefined
});

// Support both `const logger = require('./logger')` and `const { logger } = require('./logger')`
logger.logger = logger;

module.exports = logger;
