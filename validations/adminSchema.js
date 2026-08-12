const { z } = require("zod");

const adminSignupSchema = z.object({
    body: z.object({
        fullName: z.string().min(2, "Full name is required"),
        email: z.string().email("Invalid email address"),
        phone: z.string().regex(/^\d{10}$/, "Phone number must be exactly 10 digits"),
        password: z.string().min(8, "Password must be at least 8 characters"),
        secretKey: z.string().optional()
    })
});

const productSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Product name is required"),
        category: z.string().min(1, "Category is required"),
        mrp: z.preprocess((val) => Number(val), z.number().min(0, "MRP must be a non-negative number")), 
        dp: z.preprocess((val) => Number(val), z.number().min(0, "DP must be a non-negative number")), 
        pv: z.preprocess((val) => Number(val), z.number().min(0, "PV must be a non-negative number")), 
        isFeatured: z.preprocess((val) => val === "true", z.boolean()).optional()
    })
});

const userIdParamSchema = z.object({
    params: z.object({
        userId: z.preprocess((val) => Number(val), z.number().min(1, "Invalid User ID"))
    })
});

const adminApprovalSchema = z.object({
    params: z.object({
        adminId: z.preprocess((val) => Number(val), z.number().min(1, "Invalid Admin ID"))
    })
});

const updateUserDetailsSchema = z.object({
    body: z.object({
        fullName: z.string().min(2, "Full Name is required").optional(),
        email: z.string().email("Invalid email address").optional(),
        rcmId: z.string().optional(),
        status: z.enum(["pending", "active", "inactive", "premium", "banned"]).optional(),
        role: z.enum(["USER", "ADMIN", "SUPPORT"]).optional(),
        autoPayStatus: z.preprocess((val) => val === "true" || val === "false" ? JSON.parse(val) : val, z.boolean()).optional(),
        nextBillingDate: z.string().datetime().nullable().optional() // Assuming date string in ISO format
    }),
    params: z.object({
        userId: z.preprocess((val) => Number(val), z.number().min(1, "Invalid User ID"))
    })
});

const notificationSchema = z.object({
    body: z.object({
        title: z.string().min(1, "Notification title is required"),
        body: z.string().min(1, "Notification body is required"),
        imageUrl: z.string().url("Invalid image URL").optional(),
        link: z.string().url("Invalid link URL").optional()
    })
});


const adminVerifySchema = z.object({
    body: z.object({
        email: z.string().email("Invalid email address"),
        code: z.string().length(6, "Verification code must be 6 digits")
    })
});

module.exports = { adminSignupSchema, productSchema, userIdParamSchema, adminApprovalSchema, updateUserDetailsSchema, notificationSchema, adminVerifySchema };