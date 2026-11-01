const { createRcmSession } = require('../services/rcmSessionService');

(async () => {
  const buyerId = process.env.TEST_RCM_ID;
  const password = process.env.TEST_RCM_PASSWORD;

  let session;

  try {
    if (!buyerId || !password) {
      console.log('HTTP status: 0');
      console.log('Login succeeded: false');
      return;
    }

    session = createRcmSession({
      buyerId,
      password,
      options: {
        timeout: 20000,
        requestDelayMin: 400,
        requestDelayMax: 800,
        maxRetries: 2,
        retryBackoffMs: 500
      }
    });

    await session.login();
    const targetUrl = 'https://www.rcmworld.com/my-account/identity-card';
    const response = await session.get(targetUrl);
    const status = Number(response && response.status ? response.status : 0);
    const authenticated = await session.isAuthenticated();
    console.log(`HTTP status: ${status}`);
    console.log(`Login succeeded: ${authenticated ? 'true' : 'false'}`);
  } catch (error) {
    console.log('HTTP status: 0');
    console.log('Login succeeded: false');
  } finally {
    if (session) {
      session.close();
    }
  }
})();
