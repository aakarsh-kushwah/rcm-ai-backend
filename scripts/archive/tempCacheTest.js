require('dotenv').config({ path: require('path').resolve('rcm-ai-backend/.env') });
const { generateTitanResponse, aiCache } = require('../services/aiService');
const { normalizeQuery } = require('../controllers/chatController');

async function testCaching() {
    // Clear cache before test to ensure clean state
        if (process.env.NODE_ENV !== 'production') {
            aiCache.flushAll();
            console.log("🗑️ [AI CACHE] Cache flushed for testing.");
        } else {
            console.warn("⚠️ [AI CACHE] Cache flush skipped in production environment.");
        }
    console.log("🗑️ [AI CACHE] Cache flushed for testing.");

    console.log("\n--- Caching Test 1: Product Query (Expected MISS then HIT) ---");
    const user = { fullName: "TestUser", pinLevel: "Associate" };
    const productQuery = "Nutricharge S5 ke kya fayde hain?";
    const normalizedProductQuery = normalizeQuery(productQuery);

    // First request - expected cache miss
    const start1 = Date.now();
    const resp1 = await generateTitanResponse(user, productQuery, []);
    const end1 = Date.now();
    console.log(`Response Time (First Call): ${end1 - start1}ms`);
    console.log(`AI Response: ${resp1.response}`);
    console.log(`Cache Status for \"${normalizedProductQuery}\": ${aiCache.get(normalizedProductQuery) ? 'HIT' : 'MISS'}`);
    console.log(`Expected: MISS. Actual: ${aiCache.get(normalizedProductQuery) ? 'HIT' : 'MISS'}`);

    // Second request - expected cache hit
    console.log("\n--- Caching Test 1: Second Request (Cache Hit) ---");
    const start2 = Date.now();
    const resp2 = await generateTitanResponse(user, productQuery, []); // Same query
    const end2 = Date.now();
    console.log(`Response Time (Cached Call): ${end2 - start2}ms`);
    console.log(`AI Response: ${resp2.response}`);
    console.log(`Cache Status for \"${normalizedProductQuery}\": ${aiCache.get(normalizedProductQuery) ? 'HIT' : 'MISS'}`);
    console.log(`Expected: HIT. Actual: ${aiCache.get(normalizedProductQuery) ? 'HIT' : 'MISS'}`);

    console.log("\n--- Caching Test 2: Empty/No-Match Query (Expected NO CACHE) ---");
    const noMatchQuery = "ek aisi vastu jiska koi mol na ho?"; // Query designed to return no product matches
    const normalizedNoMatchQuery = normalizeQuery(noMatchQuery);

    // Request for no-match query - should not be cached
    const start3 = Date.now();
    const resp3 = await generateTitanResponse(user, noMatchQuery, []);
    const end3 = Date.now();
    console.log(`Response Time (No-Match Call): ${end3 - start3}ms`);
    console.log(`AI Response: ${resp3.response}`);
    console.log(`Cache Status for \"${normalizedNoMatchQuery}\": ${aiCache.get(normalizedNoMatchQuery) ? 'HIT' : 'MISS'}`);
    console.log(`Expected: MISS. Actual: ${aiCache.get(normalizedNoMatchQuery) ? 'HIT' : 'MISS'}`);

    // Verify no-match query is NOT in cache
    const inCacheAfterNoMatch = aiCache.get(normalizedNoMatchQuery);
    console.log(`Is No-Match Query in cache? ${inCacheAfterNoMatch ? 'Yes' : 'No'}. Expected: No.`);
}

testCaching().catch(console.error);
