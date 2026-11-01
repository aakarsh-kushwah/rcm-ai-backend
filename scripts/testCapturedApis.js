const { createRcmSession } = require('../services/rcmSessionService');

(async () => {
  const buyerId = process.env.TEST_RCM_ID || '40101044';
  const password = process.env.TEST_RCM_PASSWORD || 'RCM123';

  const session = createRcmSession({ buyerId, password });

  try {
    console.log(`1. Logging in with ID ${buyerId}...`);
    await session.login();
    console.log("Login successful!\n");

    const headers = {
      'resource': 'web',
      'Origin': 'https://rcmworld.com',
      'Referer': 'https://www.rcmworld.com/',
      'pincode': '834001',
      'language': 'EN',
      'area-name': ''
    };

    // 1. Test get-personal-info
    console.log("=== 1. TESTING GET-PERSONAL-INFO ===");
    const resPersonal = await session.client.get('https://ecomapi.rcmworld.com/api/user/profile/get-personal-info', { headers });
    console.log("Status:", resPersonal.status);
    console.log("Personal Data Keys:", Object.keys(resPersonal.data?.data || {}));
    console.log("Sample Personal Info:", JSON.stringify(resPersonal.data?.data || {}).slice(0, 300));

    // 2. Test get-distributor-info
    console.log("\n=== 2. TESTING GET-DISTRIBUTOR-INFO ===");
    const resDist = await session.client.get(`https://ecomapi.rcmworld.com/api/user/profile/get-distributor-info?dist_no=${buyerId}`, { headers });
    console.log("Status:", resDist.status);
    console.log("Distributor Data:", JSON.stringify(resDist.data).slice(0, 400));

    // 3. Test repurchase-report
    console.log("\n=== 3. TESTING REPURCHASE-REPORT ===");
    const resReport = await session.client.get(`https://ecomapi.rcmworld.com/api/report/repurchase-report?dist_no=${buyerId}`, { headers });
    console.log("Status:", resReport.status);
    console.log("Report Data Count:", resReport.data?.data?.length);
    console.log("Sample Report Node:", JSON.stringify(resReport.data?.data?.[0] || {}).slice(0, 300));

  } catch (err) {
    console.error("API Call Error:", err.response ? err.response.data : err.message);
  } finally {
    session.close();
  }
})();
