/**
 * @file config/firebase.js
 * @description TITAN FIREBASE CONNECTOR (Universal Loader)
 * @support Supports both JSON String and Individual .env variables
 */

const admin = require("firebase-admin");
require("dotenv").config();

if (!admin.apps.length) {
    try {
        console.log("🔌 [TITAN FIREBASE]: Connecting...");

        let serviceAccount;

        // SCENARIO 1: User provided the full JSON in one variable (Your Case)
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                // JSON string ko object me convert karein
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                console.log("🔑 [TITAN FIREBASE]: Loaded via FIREBASE_SERVICE_ACCOUNT JSON.");
            } catch (parseError) {
                console.error("❌ [TITAN FIREBASE]: JSON Parse Failed. Check your .env string.");
            }
        } 
        
        // SCENARIO 2: Individual Variables (Fallback)
        if (!serviceAccount && process.env.FIREBASE_PROJECT_ID) {
            serviceAccount = {
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY 
                    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
                    : undefined
            };
        }

        // Final Check
        if (!serviceAccount) {
            throw new Error("No valid Firebase Keys found in .env (FIREBASE_SERVICE_ACCOUNT is missing or invalid).");
        }

        // Initialize App
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // Project ID JSON me 'project_id' hota hai, aur variable me 'projectId'
            storageBucket: `${serviceAccount.project_id || serviceAccount.projectId}.appspot.com` 
        });
        
        console.log("✅ [TITAN FIREBASE]: System Online.");

    } catch (error) {
        console.error("❌ [TITAN FIREBASE INIT FAILED]:", error.message);
        // Hum yahan process.exit() nahi karenge taaki server baaki kaam karta rahe.
    }
}

// Safely export bucket (Check if app exists first)
const bucket = admin.apps.length ? admin.storage().bucket() : null;

module.exports = { admin, bucket };