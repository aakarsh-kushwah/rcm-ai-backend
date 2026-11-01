const { createRcmSession } = require('../services/rcmSessionService');

(async () => {
  const session = createRcmSession({
    buyerId: process.env.TEST_RCM_ID || '40101044',
    password: process.env.TEST_RCM_PASSWORD || 'RCM123'
  });

  try {
    await session.login();
    const headers = {
      'resource': 'web',
      'Origin': 'https://rcmworld.com',
      'Referer': 'https://www.rcmworld.com/',
      'pincode': '834001',
      'language': 'EN',
      'area-name': ''
    };

    // 1. Inspect personal communication_details & photo URL structure
    console.log("=== 1. ADDRESS & PIN STRUCTURE ===");
    const personalRes = await session.client.get('https://ecomapi.rcmworld.com/api/user/profile/get-personal-info', { headers });
    const pData = personalRes.data?.data || {};
    console.log("Profile Photo:", pData.dist_image);
    console.log("Highest Pin:", pData.dist_pin);
    console.log("Communication Details:", JSON.stringify(pData.communication_details, null, 2));

    // 2. Inspect repurchase-report structure for 8727967 (where 14 records exist)
    console.log("\n=== 2. GROUP/TREE REPORT STRUCTURE (8727967) ===");
    const reportRes = await session.client.get('https://ecomapi.rcmworld.com/api/report/repurchase-report?dist_no=8727967', { headers });
    const groupList = reportRes.data?.data || [];
    console.log("Total Nodes in Report:", groupList.length);
    if (groupList.length > 0) {
      console.log("Sample First 2 Nodes:");
      console.log(JSON.stringify(groupList.slice(0, 2), null, 2));
      console.log("\nAll Node Keys:", Object.keys(groupList[0]));
    }

  } catch (err) {
    console.error("Error:", err.response ? err.response.data : err.message);
  } finally {
    session.close();
  }
})();
