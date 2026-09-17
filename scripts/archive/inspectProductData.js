require('dotenv').config({ path: require('path').resolve('rcm-ai-backend/.env') });
const db = require('../models');

async function inspectProductData() {
    console.log("\n--- Inspecting Product Data for IDs: 30311, 30316, 30317 ---");
    const productIds = [30311, 30316, 30317];

    try {
        await db.sequelize.authenticate();
        console.log('Database connection has been established successfully.');

        const products = await db.Product.findAll({
            where: {
                id: productIds
            },
            attributes: ['id', 'name', 'category', 'healthBenefits', 'usageInfo'],
            raw: true
        });

        if (products.length === 0) {
            console.log("No products found for the given IDs.");
            return;
        }

        products.forEach(p => {
            console.log(`\nProduct ID: ${p.id}`);
            console.log(`  Name: ${p.name}`);
            console.log(`  Category: ${p.category}`);
            console.log(`  Health Benefits: ${JSON.stringify(p.healthBenefits)}`);
            console.log(`  Usage Info: ${JSON.stringify(p.usageInfo)}`);
        });

    } catch (error) {
        console.error("Unable to connect to the database or query products:", error);
    } finally {
        await db.sequelize.close();
        console.log('Database connection closed.');
    }
}

inspectProductData().catch(console.error);
