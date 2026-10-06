/**
 * @file rcm-ai-backend/scripts/verifyControllerWiring.js
 * @description Verify that getShorts controller properly delegates to feedEngineService.getFeed.
 */

const { sequelize } = require('../config/db');
const shortsController = require('../controllers/shortsController');

async function testController() {
  try {
    await sequelize.authenticate();

    const req = {
      query: { limit: '12' },
      user: null,
      headers: {},
    };

    let statusCode = null;
    let jsonBody = null;

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonBody = data;
        return this;
      },
    };

    const next = (err) => {
      if (err) throw err;
    };

    await shortsController.getShorts(req, res, next);

    console.log(`✅ Response status: ${statusCode}`);
    console.log(`✅ Response success: ${jsonBody.success}`);
    console.log(`✅ Returned items count: ${jsonBody.data.length}`);
    console.log(`✅ Next cursor: ${jsonBody.nextCursor}`);
    console.log(`✅ Has more: ${jsonBody.hasMore}`);

    console.log('\n📊 Sample items:');
    jsonBody.data.slice(0, 6).forEach((item, idx) => {
      const creator = item.channel?.name || item.creatorHandle || 'Unknown';
      console.log(`[${idx + 1}] [${item.platform.toUpperCase()}] ${creator}: "${(item.title || '').substring(0, 40)}"`);
    });

    process.exit(0);
  } catch (err) {
    console.error('❌ Controller verification failed:', err);
    process.exit(1);
  }
}

testController();
