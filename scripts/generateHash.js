const bcrypt = require("bcryptjs");

async function generateHash() {
    const plainTextPassword = "Titan@123";
    const SALT_ROUNDS = 10; // Must match authController and server.js
    try {
        const hashedPassword = await bcrypt.hash(plainTextPassword, SALT_ROUNDS);
        console.log(`Hash for "${plainTextPassword}": ${hashedPassword}`);
    } catch (error) {
        console.error("Error generating hash:", error);
    }
}

generateHash();