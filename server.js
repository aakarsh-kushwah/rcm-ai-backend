require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");

const { db, initialize } = require("./config/db");

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy (Render/Heroku)
app.set("trust proxy", 1);

// CORS
const allowedOrigins = [
  "https://rcm-ai-admin-ui.vercel.app",
  "https://rcm-ai-frontend.vercel.app",
  "https://rcmai.in",
  "https://www.rcmai.in",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      if (origin.endsWith(".vercel.app") || origin.endsWith(".onrender.com")) {
        return callback(null, true);
      }

      console.warn("❌ CORS Blocked:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// Rate Limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many requests. Try after 15 min.",
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: "Too many requests. Try after 15 min.",
});

// ============================================================
// START SERVER
// ============================================================
async function startServer() {
  try {
    await initialize();
    console.log("✅ DB Ready:", Object.keys(db));

    // Load Routes AFTER DB
    console.log("⏳ Loading routes...");

    const healthRoutes = require("./routes/health");
    const authRoutes = require("./routes/authRoutes");
    const subscriberRoutes = require("./routes/subscriberRoutes");
    const chatRoutes = require("./routes/chatRoutes");
    const userRoutes = require("./routes/userRoutes");
    const videoRoutes = require("./routes/videoRoutes");
    const adminRoutes = require("./routes/adminRoutes");
    const paymentRoutes = require("./routes/paymentRoutes");

    console.log("✅ Routes Loaded");

    // Apply Routes
    app.use("/", healthRoutes);
    app.use("/api/auth", authLimiter, authRoutes);
    app.use("/api", apiLimiter, subscriberRoutes);
    app.use("/api/chat", apiLimiter, chatRoutes);
    app.use("/api/users", apiLimiter, userRoutes);
    app.use("/api/videos", apiLimiter, videoRoutes);
    app.use("/api/admin", apiLimiter, adminRoutes);
    app.use("/api/payment", apiLimiter, paymentRoutes);

    console.log("✅ Routes Applied");

    // 404
    app.use((req, res) => {
      res.status(404).json({ message: `Route Not Found: ${req.originalUrl}` });
    });

    // Global Error Handler
    app.use((err, req, res, next) => {
      console.error("🔥 Global Error:", err.message);
      res.status(err.status || 500).json({
        message: err.message,
        stack: process.env.NODE_ENV === "production" ? null : err.stack,
      });
    });

    app.listen(PORT, () => {
      console.log(`🚀 Server running on PORT: ${PORT}`);
    });
  } catch (err) {
    console.error("❌ FATAL ERROR:", err);
    process.exit(1);
  }
}

startServer();
