require('dotenv').config();
const { Product, SiteMap, sequelize } = require('../models');

(async () => {
    try {
        console.log("📡 Connecting to Database...");
        await sequelize.authenticate();

        // 1. PRODUCTS CHECK
        let totalProducts = 0;
        try {
            totalProducts = await Product.count();
        } catch (e) { console.log("⚠️ Products table not ready yet."); }

        // 2. SITEMAP CHECK
        let totalLinks = 0;
        try {
            totalLinks = await SiteMap.count();
        } catch (e) { console.log("⚠️ SiteMaps table not ready yet."); }

        console.log("\n" + "=".repeat(50));
        console.log(`📊 DATABASE STATUS REPORT`);
        console.log("=".repeat(50));
        console.log(`📦 Total Products Loaded: ${totalProducts}`);
        console.log(`🗺️  Total Navigation Links: ${totalLinks}`);
        console.log("=".repeat(50) + "\n");

        if (totalProducts > 0) {
            const latestProducts = await Product.findAll({
                attributes: ['name', 'category', 'mrp', 'dp', 'pv'],
                limit: 10,
                order: [['createdAt', 'DESC']]
            });
            console.table(latestProducts.map(p => ({
                "Name": p.name.substring(0, 30),
                "MRP": p.mrp,
                "DP": p.dp,
                "PV": p.pv
            })));
        }

    } catch (error) {
        console.error("\n❌ Error:", error.message);
    } finally {
        await sequelize.close();
        process.exit(0);
    }
})();