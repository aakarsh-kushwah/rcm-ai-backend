/**
 * @file validate.js
 * @description Zod-based Input Validator for Titan Core
 */

const validate = (schema) => (req, res, next) => {
    try {
        // Validation execute karo
        schema.parse({
            body: req.body,
            query: req.query,
            params: req.params,
        });
        next();
    } catch (error) {
        // Agar data galat hai, toh gateway par hi rok do
        return res.status(400).json({
            success: false,
            message: "Validation Failed: Invalid Data Format",
            errors: error.errors.map(err => ({
                field: err.path[1] || err.path[0],
                issue: err.message
            })),
            traceId: req.id // ALPHA-14 tracing
        });
    }
};

module.exports = validate;