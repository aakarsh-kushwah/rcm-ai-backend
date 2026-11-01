const { createRcmSession } = require('../services/rcmSessionService');
const cheerio = require('cheerio');

(async () => {
  const session = createRcmSession({
    buyerId: process.env.TEST_RCM_ID || '40101044',
    password: process.env.TEST_RCM_PASSWORD || 'RCM123'
  });

  try {
    console.log("Logging in...");
    await session.login();
    console.log("Logged in successfully.\n");

    // 1. Inspect Identity Card HTML
    console.log("--- FETCHING IDENTITY CARD ---");
    const idRes = await session.get('https://www.rcmworld.com/my-account/identity-card');
    const $id = cheerio.load(idRes.data);
    const nextDataId = $id('#__NEXT_DATA__').html();
    
    if (nextDataId) {
      console.log("Found __NEXT_DATA__ on Identity Card page!");
      const parsed = JSON.parse(nextDataId);
      console.log("Page Props Keys:", Object.keys(parsed.props?.pageProps || {}));
      console.log("Sample Data:", JSON.stringify(parsed.props?.pageProps || {}).slice(0, 500));
    } else {
      console.log("No __NEXT_DATA__ found. Page title:", $id('title').text());
      console.log("Body text snippet:", $id('body').text().slice(0, 300));
    }

    // 2. Inspect Your Group HTML
    console.log("\n--- FETCHING YOUR GROUP ---");
    const groupRes = await session.get('https://www.rcmworld.com/my-account/your-group');
    const $gr = cheerio.load(groupRes.data);
    const nextDataGroup = $gr('#__NEXT_DATA__').html();

    if (nextDataGroup) {
      console.log("Found __NEXT_DATA__ on Your Group page!");
      const parsedGroup = JSON.parse(nextDataGroup);
      console.log("Group Page Props Keys:", Object.keys(parsedGroup.props?.pageProps || {}));
      console.log("Group Sample Data:", JSON.stringify(parsedGroup.props?.pageProps || {}).slice(0, 500));
    } else {
      console.log("No __NEXT_DATA__ on Group page.");
      console.log("Page title:", $gr('title').text());
      console.log("Body snippet:", $gr('body').text().slice(0, 400));
    }

  } catch (err) {
    console.error("Inspection error:", err.message);
  } finally {
    session.close();
  }
})();
