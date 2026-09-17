require('dotenv').config({ path: require('path').resolve('rcm-ai-backend/.env') });
const { generateTitanResponse } = require('../services/aiService');

async function findHealthProduct() {
    console.log("\n--- Searching for Health Products ---");
    const user = { fullName: "TestUser", pinLevel: "Associate" };
    const query = "Nutricharge S5 ke fayde batao"; // Specific product query

    try {
        const resp = await generateTitanResponse(user, query, []);
        console.log("Query:", query);
        console.log("AI Response:", resp.response);
        console.log("Product IDs found:", resp.productIds);

        if (!resp.productIds || resp.productIds.length === 0) {
            console.log("No products found for the query. This test might not show the desired 'robot-dump' behavior.");
        }

    } catch (error) {
        console.error("Error generating AI response:", error);
    }
}

findHealthProduct().catch(console.error);
