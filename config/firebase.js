const admin = require("firebase-admin");
require("dotenv").config(); // .env load karna zaroori hai

if (!admin.apps.length) {
    try {
        console.log("🔌 [TITAN FIREBASE]: Connecting via Environment Variables...");

        // 1. .env se keys construct karo (File path ki ab zarurat nahi)
        const serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // .env me new line (\n) string ban jati hai, use asli new line me badalna padta hai
            privateKey: process.env.FIREBASE_PRIVATE_KEY 
                ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
                : undefined
        };

        // 🛡️ Safety Check: Dekho keys load hui ya nahi
        if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
            throw new Error("Critical Firebase variables are missing in .env file!");
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // Audio save karne ke liye bucket ka naam (Aapke project ID se match hona chahiye)
            storageBucket: `${serviceAccount.projectId}.appspot.com` 
        });
        
        console.log("✅ [TITAN FIREBASE]: Neural Notification & Storage System Online.");

    } catch (error) {
        console.error("❌ [TITAN FIREBASE INIT FAILED]:", error.message);
        // Process crash na karein, lekin error dikhana zaroori hai
    }
}

// Storage Bucket bhi export karein (Audio feature ke liye chahiye)
const bucket = admin.storage().bucket();

module.exports = { admin, bucket };