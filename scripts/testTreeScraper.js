const { execSync } = require('child_process');
const { createRcmSession } = require('../services/rcmSessionService');
const { scrapeIdentityCard } = require('../services/rcmIdentityScraper');
const { scrapeYourGroup } = require('../services/rcmGroupScraper');
const { searchLifelineMembers } = require('../utils/treeSearchHelper');
const { DownlineNode, RcmIdentity } = require('../models');

(async () => {
  const buyerId = process.env.TEST_RCM_ID;
  const password = process.env.TEST_RCM_PASSWORD;

  if (!buyerId || !password) {
    console.log('TEST_RCM_ID / TEST_RCM_PASSWORD are required.');
    process.exit(1);
  }

  console.log('Running migrations...');
  try {
    execSync('npx sequelize-cli db:migrate --env development', { stdio: 'inherit' });
  } catch (error) {
    console.error('Migration failed.');
    console.error(error.message);
    process.exit(1);
  }

  console.log('--- DESCRIBE rcm_identities ---');
  try {
    execSync('npx sequelize-cli db:migrate --env development --help > /tmp/skip.txt', { stdio: 'ignore' });
  } catch (error) {
    // no-op
  }

  try {
    const { sequelize } = require('../config/db');
    const identityDescribe = await sequelize.query('DESCRIBE rcm_identities');
    console.log(JSON.stringify(identityDescribe[0], null, 2));
    const downlineDescribe = await sequelize.query('DESCRIBE rcm_downline_nodes');
    console.log('--- DESCRIBE rcm_downline_nodes ---');
    console.log(JSON.stringify(downlineDescribe[0], null, 2));
  } catch (error) {
    console.error('DESCRIBE failed:', error.message);
    process.exit(1);
  }

  let session;
  try {
    session = createRcmSession({ buyerId, password, options: { timeout: 20000, requestDelayMin: 400, requestDelayMax: 800, maxRetries: 2, retryBackoffMs: 500 } });
    const loginOk = await session.login();
    if (!loginOk) {
      throw new Error('RCM login failed');
    }

    const identity = await scrapeIdentityCard(session, Number(buyerId));
    console.log('Identity profile:', JSON.stringify(identity));

    const summary = await scrapeYourGroup(session, Number(buyerId));
    console.log('Group summary:', JSON.stringify(summary));

    const numericSearch = await searchLifelineMembers({ rootBuyerId: Number(buyerId), searchQuery: String(Number(buyerId) || 1), limit: 20 });
    console.log('Numeric search result:', JSON.stringify(numericSearch));

    const nameSearch = await searchLifelineMembers({ rootBuyerId: Number(buyerId), searchQuery: 'A', limit: 20 });
    console.log('Name search result count:', Array.isArray(nameSearch) ? nameSearch.length : 0);

    const start = Date.now();
    await searchLifelineMembers({ rootBuyerId: Number(buyerId), searchQuery: 'A', limit: 20 });
    const elapsed = Date.now() - start;
    console.log('Name search elapsed ms:', elapsed);
    if (elapsed >= 50) {
      throw new Error(`Search too slow: ${elapsed}ms`);
    }
  } catch (error) {
    console.error('Smoke test failed:', error.message);
    process.exit(1);
  } finally {
    if (session) session.close();
  }
})();
