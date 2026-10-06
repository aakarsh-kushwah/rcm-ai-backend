/**
 * @file rcm-ai-backend/scripts/verifyFeedEngine.js
 * @description Test script to verify round-robin multi-bucket feed output for GET /api/shorts?limit=12.
 */

const { sequelize } = require('../config/db');
const feedEngineService = require('../services/feedEngineService');

async function runTest() {
  try {
    console.log('🔄 Connecting to database...');
    await sequelize.authenticate();
    console.log('✅ Database connected successfully.');

    console.log('\n🚀 Fetching feed with limit=12...');
    const result = await feedEngineService.getFeed('verify_test_user', null, 12);
    
    console.log(`\n📊 Feed Results (Total items: ${result.data.length}):`);
    console.log('--------------------------------------------------------------------------------');
    result.data.forEach((item, index) => {
      const creator = item.channel?.name || item.creatorHandle || 'Unknown Creator';
      const handle = item.channel?.handle || item.creatorHandle || '';
      console.log(`[${index + 1}] Platform: ${item.platform.toUpperCase()} | Creator: ${creator} (${handle}) | Title: "${(item.title || '').substring(0, 50)}" | URL: ${item.videoUrl}`);
    });
    console.log('--------------------------------------------------------------------------------');

    const platforms = result.data.reduce((acc, item) => {
      acc[item.platform] = (acc[item.platform] || 0) + 1;
      return acc;
    }, {});
    console.log('📈 Platform breakdown:', platforms);

    const creators = new Set(result.data.map(item => item.channel?.name || item.creatorHandle));
    console.log(`👥 Unique creators represented: ${creators.size}`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Verification test failed:', err);
    process.exit(1);
  }
}

runTest();
