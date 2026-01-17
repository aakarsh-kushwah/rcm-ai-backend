/**
 * @file src/services/rcmScraper.js
 * @description TITAN V5: HUMAN-MIMIC & DEEP CONTROL (RAT MODE)
 * Features: Infinite Patience, Mouse Emulation, Tab Breaking, Deep DOM Surgery.
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const { Product } = require('../models');

const CONFIG = {
    baseUrl: 'https://www.rcmworld.com',
    // 0 = No Timeout (Jitna time lage lagne do)
    navigationTimeout: 0, 
    minActionDelay: 2000,
    maxActionDelay: 5000
};

// 🧠 HELPER: Random Delay (Insaan ek speed par kaam nahi karta)
const randomDelay = (min = CONFIG.minActionDelay, max = CONFIG.maxActionDelay) => 
    new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// 🖱️ HELPER: Human Mouse Movement
async function humanMoves(page) {
    try {
        // Randomly move mouse across the screen
        await page.mouse.move(
            Math.floor(Math.random() * 500), 
            Math.floor(Math.random() * 500)
        );
        await page.mouse.move(
            Math.floor(Math.random() * 1024), 
            Math.floor(Math.random() * 768)
        );
    } catch(e) {}
}

// 📜 HELPER: Smart Auto-Scroll (Ruk-Ruk ke scroll karna)
async function humanScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                // Scroll random amount
                window.scrollBy(0, distance + Math.floor(Math.random() * 50));
                totalHeight += distance;

                // Stop when reached bottom
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 300); // Slower scrolling
        });
    });
}

// ⏳ HELPER: Wait for Network Stability (Jab tak site shant na ho jaye)
async function waitForStability(page) {
    try {
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
        // Wait for specific RCM loaders to disappear (if any)
        await page.waitForSelector('.loader, .spinner, .loading', { hidden: true, timeout: 5000 }).catch(() => {});
    } catch (e) {}
}

async function scrapeAndSave() {
    console.log("\n🚀 [TITAN V5 HUMAN-BOT] INITIALIZING SYSTEM...");

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: [
            '--start-maximized', 
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled' // Chupata hai ki ye bot hai
        ]
    });

    const page = await browser.newPage();
    
    // 🛑 INFINITE TIMEOUT: Kabhi fail nahi hoga time ki wajah se
    page.setDefaultNavigationTimeout(0); 
    page.setDefaultTimeout(0);

    // 🎭 Masking: Advanced User Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        console.log("🌍 Entering RCM World...");
        await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded' });
        
        console.log("🔐 WAITING 60s FOR MANUAL LOGIN/OTP...");
        await new Promise(r => setTimeout(r, 60000)); 

        // --- PHASE 1: INTELLIGENT NAVIGATION ---
        console.log("📡 Scanning Navigation Menu...");
        await humanMoves(page); // Wake up the UI

        // Force Hover on menus to load lazy-loaded links
        await page.evaluate(() => {
            const menus = document.querySelectorAll('.nav-item, .dropdown-toggle, .menu-link');
            menus.forEach(m => {
                const event = new MouseEvent('mouseover', { 'view': window, 'bubbles': true, 'cancelable': true });
                m.dispatchEvent(event);
            });
        });
        await randomDelay(2000, 4000);

        // Collect Links
        const collectionLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/category/"], a[href*="/brand/"]'));
            return links
                .map(a => ({ title: a.innerText.trim(), href: a.href }))
                .filter(l => l.title.length > 2 && !l.href.includes('#'))
                .filter((v, i, a) => a.findIndex(t => (t.href === v.href)) === i);
        });

        console.log(`🔎 Found ${collectionLinks.length} Collections to Scan.`);

        // --- PHASE 2: DEEP DIVE ---
        for (const collection of collectionLinks) {
            console.log(`\n🌊 VISITING: ${collection.title}`);
            
            try {
                await page.goto(collection.href);
                await waitForStability(page);
                
                // 🎡 Handle Carousels & Sliders
                console.log("   🎡 Checking for sliders...");
                try {
                    const arrows = await page.$$('.slick-next, .owl-next, .next-btn');
                    for (const arrow of arrows) {
                        if (await arrow.isIntersectingViewport()) {
                            await arrow.click();
                            await randomDelay(500, 1000);
                        }
                    }
                } catch(e) {}

                // 📜 Human Scroll (Load Lazy Images)
                console.log("   📜 Reading page (Scrolling)...");
                await humanScroll(page);

                // 📦 Get Products
                const productLinks = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="/product/"]'))
                        .map(a => a.href)
                        .filter((v, i, a) => a.indexOf(v) === i);
                });

                console.log(`      🎯 Found ${productLinks.length} products. Starting inspection...`);

                // --- PHASE 3: SURGICAL EXTRACTION ---
                for (const link of productLinks) {
                    const productPage = await browser.newPage();
                    productPage.setDefaultNavigationTimeout(0); // Infinite wait

                    try {
                        // 1. Load Page
                        await productPage.goto(link);
                        await waitForStability(productPage);
                        await humanMoves(productPage); // Shake mouse

                        // 2. 🧨 TAB BREAKER: Open 'Description', 'Ingredients', 'More Info'
                        console.log("         🔨 Smashing Tabs & Accordions...");
                        await productPage.evaluate(() => {
                            const triggers = document.querySelectorAll('.accordion-button, .tab-link, button[aria-expanded="false"], .read-more');
                            triggers.forEach(t => t.click());
                        });
                        await randomDelay(1000, 2000); // Wait for tabs to open

                        // 3. 🔄 VARIANT LOOPER (Sizes/Colors)
                        const variants = await productPage.$$('.variant-option, .size-swatch, .attribute-button');
                        let loops = variants.length > 0 ? variants.length : 1;

                        for(let i = 0; i < loops; i++) {
                            if(variants.length > 0) {
                                // Click Variant
                                await variants[i].click();
                                process.stdout.write(`         👆 Clicking Variant ${i+1}... `);
                                await waitForStability(productPage); // Price loading wait
                                await randomDelay(1000, 2000);
                            }

                            // 4. 🧬 EXTRACTION
                            const data = await productPage.evaluate((catTitle, url, idx) => {
                                const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
                                const bodyText = document.body.innerText;
                                
                                // Robust Price Regex
                                const getPrice = (pattern) => {
                                    const match = bodyText.match(new RegExp(pattern, 'i'));
                                    return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
                                };

                                let name = getText('h1') || document.title;
                                const activeVariant = document.querySelector('.active, .selected')?.innerText;
                                if(activeVariant && !name.includes(activeVariant)) name += ` - ${activeVariant}`;

                                // Extract Tables (Specs)
                                const tableData = Array.from(document.querySelectorAll('table tr'))
                                    .map(tr => tr.innerText.replace(/\n/g, ': '))
                                    .join(' | ');

                                // Hidden JSON-LD (Search Engine Data)
                                let hiddenJson = {};
                                try {
                                    const script = document.querySelector('script[type="application/ld+json"]');
                                    if(script) hiddenJson = JSON.parse(script.innerText);
                                } catch(e){}

                                return {
                                    name: hiddenJson.name || name,
                                    category: catTitle,
                                    mrp: getPrice('MRP\\s*[:|-]?\\s*₹?\\s*([\\d,.]+)'),
                                    sp: getPrice('(?:S\\.P|DP|Offer Price)\\s*[:|-]?\\s*₹?\\s*([\\d,.]+)'),
                                    pv: getPrice('(?:P\\.V|PV|Business Volume)\\s*[:|-]?\\s*([\\d,.]+)'),
                                    productUrl: url,
                                    imageUrl: hiddenJson.image || document.querySelector('img[class*="main"]')?.src,
                                    description: hiddenJson.description || getText('#description') || getText('.description') || "N/A",
                                    ingredients: getText('.ingredients') || "Check Description",
                                    usage: getText('.how-to-use') || "Check Description",
                                    specs: tableData,
                                    variantIndex: idx
                                };
                            }, collection.title, link, i);

                            // 5. SAVE
                            if (data.mrp > 0 || data.sp > 0) {
                                await Product.upsert({
                                    sku: `${data.productUrl}-${data.variantIndex}`, // Unique ID
                                    ...data,
                                    aiTags: [collection.title, "TITAN-V5-RAT"]
                                });
                                console.log(`✅ Saved: ${data.name} (₹${data.sp})`);
                            } else {
                                console.log(`⚠️ Data missing for ${data.name}`);
                            }
                        }

                    } catch (err) {
                        console.log(`❌ Error on product: ${err.message}`);
                    } finally {
                        await productPage.close();
                    }
                }
            } catch (err) {
                console.log(`Category Error: ${err.message}`);
            }
        }
        console.log("\n👑 SYSTEM SHUTDOWN: ALL TASKS COMPLETED.");

    } catch (err) {
        console.error("FATAL ERROR:", err);
    }
}

module.exports = { scrapeAndSave };