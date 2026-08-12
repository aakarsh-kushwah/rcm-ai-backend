const { z } = require("zod");

const userRegisterSchema = z.object({
    body: z.object({
        fullName: z.string().min(2, "Full Name is required"),
        email: z.string().email("Invalid email address"),
        phone: z.string().optional(),
        password: z.string().min(8, "Password must be at least 8 characters"),
        rcmId: z.string().optional()
    })
});

module.exports = { userRegisterSchema };