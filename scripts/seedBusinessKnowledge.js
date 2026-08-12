/**
 * @file rcm-ai-backend/scripts/seedBusinessKnowledge.js
 * @description Seed script to populate the BusinessKnowledge table with RCM Marketing Plan V3 (Effective 1 July 2026).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize, Sequelize } = require('../config/db');
const BusinessKnowledge = require('../models/BusinessKnowledge')(sequelize, Sequelize.DataTypes);

const businessData = [
    {
        category: "PV_BV_Rules",
        title: "The Metric Rule & Accumulation",
        keywords: "pv,bv,purchase volume,business volume,accumulation,currency",
        content: "PV (Purchase Volume) is the ONLY currency for calculation. BV: If user says BV, silently treat it as PV. Accumulation: PV accumulates for Pin Level calculation in early stages (100-4999 PV)."
    },
    {
        category: "Performance_Bonus",
        title: "Performance Bonus Slabs (0% to 22%)",
        keywords: "performance bonus,slab,percentage,pin title,100,5000,10000,20000,40000,70000,115000,170000,260000,350000,differential,accrual",
        content: "Performance Bonus Slabs (Effective 1 July 2026):\n- 100 - 4,999 PV: 0% (Registered Buyer)\n- 5,000 - 9,999 PV: 2% (Beginner)\n- 10,000 - 19,999 PV: 4.5% (Starter)\n- 20,000 - 39,999 PV: 7% (Opener)\n- 40,000 - 69,999 PV: 9.5% (Eagle - Vital Growth Bonus Starts)\n- 70,000 - 1,14,999 PV: 12% (Runner)\n- 1,15,000 - 1,69,999 PV: 14.5% (Winner)\n- 1,70,000 - 2,59,999 PV: 17% (Star)\n- 2,60,000 - 3,49,999 PV: 19.5% (Gold - Royalty Gateway)\n- 3,50,000 & Above PV: 22% (Star Gold - Performance Cap)\nRules: Minimum eligibility Rs. 100 purchase on accrual basis monthly. Calculated on differential basis - group ka aggregate incentive apne se ghatakar net incentive milta hai."
    },
    {
        category: "Consistency_Bonus",
        title: "Monthly Consistency Reward & Retention Plan",
        keywords: "consistency,retention,1500 pv,2500 pv,5000 pv,club,free products,redemption,shortfall",
        content: "Consistency Reward & Retention Plan (Effective 1 July 2026):\n- 100 to 1,499 PV monthly: 12% of Total 6-month PV as digital coupon.\n- 1,500 or More PV monthly: 6 months = ₹1,500 DP value FREE products.\n- 2,500 or More PV monthly: 6 months = ₹2,500 DP value FREE products (Recommended).\n- 5,000 or More PV monthly: 6 months = ₹5,000 DP value FREE products.\nRules: 6 consecutive months qualifying purchase -> digital coupon. Redemption window 45-135 days after 6 months. Max 3 times collection. Shortfall rule: 1500/2500/5000 slabs me kami ho to agle mahine double shortfall + regular purchase karna hota hai; 100-1499 slab me kami ho to 1500 PV agle mahine karna hota hai warna 100-1499 slab me downgrade."
    },
    {
        category: "Royalty_Bonus",
        title: "Royalty Bonus Tiers and Leg Requirements",
        keywords: "royalty,gold,star gold,platinum,star platinum,main leg,second leg,3 percent,4.5 percent,6 percent,8 percent,3.50 lakh,1.15 lakh,2500 pv,wwq",
        content: "Royalty Bonus (Diff Basis | Self PV: 2500 Mandatory):\n- Main Leg: 3.50 Lakh | Second Leg: 1.15 Lakh -> 3% (Gold)\n- Main Leg: 3.50 Lakh | Second Leg: 1.70 Lakh -> 4.5% (Star Gold)\n- Main Leg: 3.50 Lakh | Second Leg: 2.60 Lakh -> 6% (Platinum)\n- Main Leg: 3.50 Lakh | Second Leg: 3.50 Lakh -> 8% (Star Platinum)\nRules: Minimum personal purchase: 2500 PV monthly (accrual basis) eligibility ke liye. Compulsory: 2 meetings/month at WWQ (free of charge). Eligibility trigger: jab kisi ek group ka PV 3,50,000 se zyada ho aur baki group ka PV 1,15,000 se kam na ho."
    },
    {
        category: "Technical_Bonus",
        title: "Technical Bonus Tiers and Requirements",
        keywords: "technical bonus,pearl,star pearl,emerald,star emerald,ruby,star ruby,sapphire,star sapphire,diamond,leg a,leg b,2500 pv,wwq,8 percent royalty",
        content: "Technical Bonus (Diff Basis | Self PV: 2500 Mandatory):\n- Pearl (1%): A: 5L | B: 5L\n- Star Pearl (1.75%): A: 10L | B: 10L\n- Emerald (2.5%): A: 22L | B: 22L\n- Star Emerald (3%): A: 48L | B: 48L\n- Ruby (3.50%): A: 100L (1 Cr) | B: 100L (1 Cr)\n- Star Ruby (4%): A: 200L (2 Cr) | B: 200L (2 Cr)\n- Sapphire (4.50%): A: 500L (5 Cr) | B: 500L (5 Cr)\n- Star Sapphire (4.75%): A: 1000L (10 Cr) | B: 1000L (10 Cr)\n- Diamond (5%): A: 2500L (25 Cr) | B: 2500L (25 Cr)\nRules: Minimum 2500 PV monthly eligibility, 8% Royalty consecutive 3 months pre-condition, aur 2 WWQ + 2 open meetings/month compulsory requirement."
    },
    {
        category: "Vital_Level_Pin_Chart",
        title: "Vital Level Pin Chart (Growth Bonus Eligibility)",
        keywords: "vital level,pin chart,opener,eagle,runner,winner,star,70000,115000,170000,260000,350000,other group",
        content: "Vital Level Pin Chart (Effective 1 July 2026):\n- 1 | Opener | Total PV: 70,000+ | Min Other Group PV: 20,000+\n- 2 | Eagle | Total PV: 1,15,000+ | Min Other Group PV: 30,000+\n- 3 | Runner | Total PV: 1,70,000+ | Min Other Group PV: 40,000+\n- 4 | Winner | Total PV: 2,60,000+ | Min Other Group PV: 50,000+\n- 5 | Star | Total PV: 3,50,000+ | Min Other Group PV: 70,000+"
    },
    {
        category: "Pin_Level_Income_Chart",
        title: "Pin Level Income & Milestone Chart",
        keywords: "pin level income,milestone,beginner,starter,opener,eagle,runner,winner,star,gold,star gold,platinum,star platinum,pearl,star pearl,emerald,star emerald,ruby,star ruby,sapphire,star sapphire,diamond,star diamond",
        content: "Pin Level Income & Milestone Chart (20 Levels):\n1. Registered Buyer (100-4999 PV)\n2. Beginner (5000 PV)\n3. Starter (10000 PV)\n4. Opener (20000 PV)\n5. Eagle (40000 PV)\n6. Runner (70000 PV)\n7. Winner (115000 PV)\n8. Star (170000 PV)\n9. Gold (260000 PV)\n10. Star Gold (350000 PV)\n11. Platinum\n12. Star Platinum\n13. Pearl\n14. Star Pearl\n15. Emerald\n16. Star Emerald\n17. Ruby\n18. Star Ruby\n19. Sapphire\n20. Star Sapphire / Diamond / Star Diamond"
    },
    {
        category: "Growth_Bonus",
        title: "Monthly & Yearly Growth Bonuses",
        keywords: "growth bonus,vital growth,royalty growth,technical growth,pool,1 percent,points,april march,annual",
        content: "Monthly & Yearly Growth Bonuses (Effective 1 July 2026):\n1. Monthly Vital Growth Bonus: Pool = 1% of Company Total Net Monthly PV. Points: Opener=1, Eagle=2, Runner=3, Winner=4, Star=5. Eligibility: Min 1500 PV personal purchase/month.\n2. Monthly Royalty Growth Bonus: Pool = 1% of Company Total Net Monthly PV. Points: Gold=10, Star Gold=11, Platinum=12, Star Platinum=13. Eligibility: Min 2500 PV, 2 WWQ meetings/month.\n3. Monthly Technical Growth Bonus: Pool = 1% of Company Total Net Monthly PV. Points: Pearl=10, Star Pearl=12, Emerald=14, Star Emerald=16, Ruby=18, Star Ruby=20, Sapphire=22, Star Sapphire=24, Diamond=26. Eligibility: Min 2500 PV, 2 WWQ + 2 open meetings/month.\n4. Yearly versions (April-March): Same 1% pool logic, points summed monthly across the year. Calculation: 1% pool divided by total points to get per-point amount."
    },
    {
        category: "Paint_Purchase_Bonus",
        title: "Paints Purchase Bonus",
        keywords: "paint purchase bonus,paint,25 percent,5000 pv,1 may 2026",
        content: "Paints Purchase Bonus (Effective 1 May 2026):\n- If monthly net paint purchase is 5000 PV or greater -> 25% Paint Purchase Bonus (monthly basis).\n- Paint purchase counts towards PV eligibility for Performance Incentive, Royalty, Technical, and Growth Bonuses, BUT does NOT count towards Consistency Reward/Bonus."
    },
    {
        category: "Policy_FAQ",
        title: "General RCM Business Guidelines",
        keywords: "joining,kyc,guidelines,rules,disclaimer,upline,sponsor",
        content: "General RCM Policies: Joining is free with valid KYC. Always maintain ethical direct selling practices. Supplements disclaimer: Ye supplement hai, medicine nahi."
    }
];

async function seed() {
    try {
        await sequelize.authenticate();
        await sequelize.sync({ force: false, alter: true });
        console.log("🌱 Seeding Business Knowledge Base with Marketing Plan V3...");

        for (const item of businessData) {
            await BusinessKnowledge.upsert({
                category: item.category,
                title: item.title,
                keywords: item.keywords,
                content: item.content,
                isActive: true
            }, { where: { title: item.title } });
            console.log(`✅ Upserted: ${item.title} [Category: ${item.category}]`);
        }

        console.log("🎉 Business Knowledge Seeding Complete!");
        await sequelize.close();
        process.exit(0);
    } catch (e) {
        console.error("❌ Seeding Failed:", e);
        process.exit(1);
    }
}

seed();
