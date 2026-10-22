/**
 * @file middleware/metrics.js
 * @description Prometheus metrics (request duration) + protected /metrics handler.
 */

const crypto = require("crypto");
const client = require("prom-client");

const IS_PROD = process.env.NODE_ENV === "production";
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
});

/** Low-cardinality route label (uses the route pattern, never the raw URL). */
const metricsMiddleware = (isInfraPath) => (req, res, next) => {
    if (isInfraPath(req)) return next();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
        const route = req.route ? `${req.baseUrl}${req.route.path}` : "unmatched";
        end({ method: req.method, route, status_code: res.statusCode });
    });
    next();
};

const safeEqual = (a, b) => {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

const metricsHandler = async (req, res, next) => {
    try {
        // In production the endpoint stays disabled unless a token is configured.
        if (IS_PROD && !METRICS_TOKEN) return res.status(404).end();

        if (METRICS_TOKEN && !safeEqual(req.headers.authorization || "", `Bearer ${METRICS_TOKEN}`)) {
            return res.status(401).end();
        }

        res.setHeader("Content-Type", register.contentType);
        res.send(await register.metrics());
    } catch (err) {
        next(err);
    }
};

module.exports = { metricsMiddleware, metricsHandler };