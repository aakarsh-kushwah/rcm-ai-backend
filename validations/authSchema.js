const { z } = require('zod');

const loginSchema = z.object({
    body: z.object({
        loginId: z.string().min(1, "Login ID is required"),
        password: z.string().min(1, "Password is required")
    })
});

const otpVerificationSchema = z.object({
    body: z.object({
        email: z.string().email(),
        otp: z.string().length(6, "OTP must be 6 digits"),
    })
});

module.exports = { loginSchema, otpVerificationSchema };