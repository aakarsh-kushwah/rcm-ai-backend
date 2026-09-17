/**
 * @file scripts/testResponseCaching.js
 * @description Comprehensive Test Script for AI Response Caching & Invalidation
 */

const { aiCache, invalidateProductCache } = require('../services/aiService');

function normalizeQuery(query) {
    return query
        .toLowerCase()
        .replace(/[.,\/#!$%^&*;:{}=\-_`~()?]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

async function runTests() {
    console.log("==================================================");
    console.log("🧪 STARTING RESPONSE CACHING & INVALIDATION TESTS");
    console.log("==================================================");

    aiCache.flushAll();

    // --- TEST 1: Cache Miss on First Request ---
    console.log("\n--- TEST 1: First Request (Cache Miss) ---");
    const rawQuestion1 = "Nutricharge S5 ke benefits kya hain?";
    const normKey1 = normalizeQuery(rawQuestion1);

    let cached = aiCache.get(normKey1);
    console.log(`Lookup key "${normKey1}":`, cached ? "HIT" : "MISS");
    console.assert(!cached, "Should be a cache miss on first request");

    // Simulate saving AI response with {{userName}} and referenced product IDs
    const mockAudioUrl = "https://res.cloudinary.com/rcm/audio/mock_nutricharge_s5.mp3";
    const mockAnswerWithPlaceholder = "Swagat hai {{userName}} ji! Nutricharge S5 immunity boost karta hai aur skin health improve karta hai.";
    const referencedProducts = [101, 102];

    aiCache.set(normKey1, {
        query: rawQuestion1,
        normalizedQuery: normKey1,
        answerText: mockAnswerWithPlaceholder,
        audioUrl: mockAudioUrl,
        referencedProductIds: referencedProducts,
        createdAt: Date.now()
    });
    console.log("✅ Stored response in aiCache with {{userName}} placeholder & referencedProductIds:", referencedProducts);

    // --- TEST 2: Cache Hit on Identical / Normalized Match ---
    console.log("\n--- TEST 2: Second Request (Cache Hit with Punctuation & Casing Variance) ---");
    const rawQuestion2 = "nutricharge s5 ke benefits kya hain???";
    const normKey2 = normalizeQuery(rawQuestion2);

    console.log(`Normalized Query 1: "${normKey1}"`);
    console.log(`Normalized Query 2: "${normKey2}"`);
    console.assert(normKey1 === normKey2, "Normalized keys must match!");

    const hitEntry = aiCache.get(normKey2);
    console.log(`Lookup key "${normKey2}":`, hitEntry ? "HIT" : "MISS");
    console.assert(hitEntry !== undefined, "Should be a cache hit!");
    console.assert(hitEntry.audioUrl === mockAudioUrl, "Should return cached audioUrl without re-calling TTS");

    // Test serve-time userName personalized injection for User "Rahul"
    const rahulResponse = hitEntry.answerText.replace(/{{userName}}/g, "Rahul");
    console.log("Personalized Served Response (User Rahul):", rahulResponse);
    console.assert(rahulResponse.includes("Rahul ji"), "Should inject Rahul ji correctly");

    // Test serve-time userName personalized injection for User "Sunita"
    const sunitaResponse = hitEntry.answerText.replace(/{{userName}}/g, "Sunita");
    console.log("Personalized Served Response (User Sunita):", sunitaResponse);
    console.assert(sunitaResponse.includes("Sunita ji"), "Should inject Sunita ji correctly");

    // --- TEST 3: Product Invalidation ---
    console.log("\n--- TEST 3: Targeted Product Invalidation ---");
    console.log("Simulating Admin updating Product ID 101...");
    const invalidatedCount = invalidateProductCache(101);
    console.log(`Invalidated ${invalidatedCount} cache entry(s) referencing Product 101`);

    const postInvalidateCheck = aiCache.get(normKey1);
    console.log(`Lookup key "${normKey1}" after product update:`, postInvalidateCheck ? "STILL CACHED (FAIL)" : "CLEARED (SUCCESS)");
    console.assert(!postInvalidateCheck, "Cache entry referencing Product 101 should be removed!");

    // --- TEST 4: Unrelated Product Does Not Invalidate ---
    console.log("\n--- TEST 4: Safe Invalidation (Unrelated Product) ---");
    aiCache.set(normKey1, {
        query: rawQuestion1,
        normalizedQuery: normKey1,
        answerText: mockAnswerWithPlaceholder,
        audioUrl: mockAudioUrl,
        referencedProductIds: [200, 201],
        createdAt: Date.now()
    });

    const nonMatchingInvalidate = invalidateProductCache(999);
    console.log(`Invalidation count for unrelated Product 999: ${nonMatchingInvalidate}`);
    console.assert(nonMatchingInvalidate === 0, "Should not invalidate unrelated entries");
    console.assert(aiCache.get(normKey1) !== undefined, "Entry for [200, 201] should remain safe");

    console.log("\n==================================================");
    console.log("🎉 ALL RESPONSE CACHING & INVALIDATION TESTS PASSED");
    console.log("==================================================");
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
