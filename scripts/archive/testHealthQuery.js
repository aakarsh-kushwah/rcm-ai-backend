require('dotenv').config({ path: require('path').resolve('rcm-ai-backend/.env') });
const { generateTitanResponse } = require('../services/aiService');

async function testHealthQuery() {
    console.log("\n--- Health-Related Product Query Test ---");
    const user = { fullName: "TestUser", pinLevel: "Associate" };
    const query = "ghutno mein dard hota hai, kya karu?";

    const start = Date.now();
    const resp = await generateTitanResponse(user, query, []);
    const end = Date.now();
    console.log(`Response Time: ${end - start}ms`);
    console.log(`AI Response: ${resp.response}`);
    console.log(`Product IDs: ${JSON.stringify(resp.productIds)}`);
}

testHealthQuery().catch(console.error);
