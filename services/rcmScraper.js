/**
 * @file services/rcmScraper.js
 * @description TITAN V41: NUCLEAR MINER (Sibling Scanner + Force Scroll + Brute Login)
 * @status PRODUCTION READY | TARGET: RCMWORLD.COM
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const { Product } = require('../models');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.rcmworld.com';
const SESSION_FILE = path.join(__dirname, 'rcm_session.json');

const CATEGORIES = [
    `${BASE_URL}/category/food-grocery`,
    `${BASE_URL}/category/personal-care`,
    `${BASE_URL}/category/health-care`,
    // `${BASE_URL}/category/household`,
    `${BASE_URL}/category/kid-s-wear`,
    `${BASE_URL}/category/luggage-bags`,
    `${BASE_URL}/category/electronics`,
    `${BASE_URL}/category/paints-construction`,
    `${BASE_URL}/category/stationery`,
    `${BASE_URL}/category/home-kitchen`,
    `${BASE_URL}/category/home-furnishing`,
    `${BASE_URL}/category/books-promotional-tools`,
    `${BASE_URL}/category/men-s-wear`,
    `${BASE_URL}/category/women-s-wear`,
    `${BASE_URL}/category/agriculture`,
    `${BASE_URL}/category/footwear`
];

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================================
// 1. SESSION & DB UTILS
// ==========================================
async function saveSession(page) {
    try {
        const cookies = await page.cookies();
        fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
    } catch (e) { }
}

async function loadSession(page) {
    if (fs.existsSync(SESSION_FILE)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(SESSION_FILE));
            await page.setCookie(...cookies);
            return true;
        } catch (e) { }
    }
    return false;
}

// 🔥 CRASH PROOF DB SAVER
async function saveProductSafe(data) {
    let retries = 3;
    await wait(200); // 🛑 Throttle DB

    while(retries > 0) {
        try {
            const finalCategory = (data.category && data.category !== '') ? data.category : 'RCM-General';
            
            let smartTags = [`rcm-${finalCategory}`.replace(/\s+/g, '-').toLowerCase()];
            if(data.ingredients && data.ingredients.length > 0) {
                smartTags.push(...data.ingredients.slice(0, 3));
            } else {
                smartTags.push("rcm-product");
            }

            await Product.upsert({
                productUrl: data.url,
                name: data.name,
                description: data.description, 
                mrp: data.mrp,
                dp: data.dp || data.mrp,
                pv: data.pv,
                imageUrl: data.img,
                sitePath: data.sitePath,
                ingredients: data.ingredients, 
                healthBenefits: data.healthBenefits, 
                usageInfo: data.usageInfo,
                category: finalCategory,
                aiTags: smartTags
            });
            return true;
        } catch (e) {
            console.warn(`⚠️ DB Error (${e.message}). Retrying...`);
            retries--;
            await wait(3000); 
        }
    }
    console.error(`❌ Failed to save ${data.name}`);
    return false;
}

// ==========================================
// 2. EXPERT LOGIN (V41 - BRUTE FORCE)
// ==========================================
async function performExpertLogin(page) {
    console.log("🔐 [TITAN] Login Sequence...");
    await loadSession(page);
    try { await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 90000 }); } catch(e) {}

    const isLoggedIn = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('sign out') || text.includes('logout') || text.includes('hi,');
    });

    if (isLoggedIn) { console.log("✅ Already Logged In."); return true; }

    console.log("🖱️ Opening Sign In Modal...");
    try {
        await page.waitForSelector('a, button', { timeout: 5000 });
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('a, button, span'));
            const loginBtn = btns.find(el => el.innerText.trim().toUpperCase() === 'SIGN IN');
            if(loginBtn) loginBtn.click();
        });
    } catch(e) { }

    await wait(2000);

    // 🛠️ FIX: Force Click "As User Id"
    console.log("🔀 Switching Tab...");
    await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('li, div, span'));
        const userTab = items.find(el => el.innerText && el.innerText.trim() === 'As User Id');
        if (userTab) {
            userTab.click();
            // Force focus to trigger events
            userTab.dispatchEvent(new Event('focus'));
        }
    });
    
    await wait(2000); // Give it time to render input

    console.log("⌨️ Typing Credentials...");
    try {
        // 🛠️ FIX: Select ANY visible input if specific one fails
        const user = process.env.RCM_USERNAME || '';
        const pass = process.env.RCM_PASSWORD || '';

        const filled = await page.evaluate((u, p) => {
            // Priority 1: Placeholder match
            let idInput = document.querySelector('input[placeholder*="User ID"]');
            
            // Priority 2: Generic text input
            if(!idInput) {
                const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"]'));
                idInput = inputs.find(i => i.offsetParent !== null); // Must be visible
            }

            const passInput = document.querySelector('input[type="password"]');

            if(idInput && passInput) {
                idInput.value = u;
                idInput.dispatchEvent(new Event('input', { bubbles: true }));
                passInput.value = p;
                passInput.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            return false;
        }, user, pass);

        if(!filled) throw new Error("Input fields not found");

        await wait(500);
        console.log("🚀 Submitting...");
        await page.keyboard.press('Enter');
        
        // Backup Click
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const sub = btns.find(b => b.type === 'submit' || b.innerText.includes('Sign In'));
            if(sub) sub.click();
        });

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
        console.log("🎉 Login Process Finished.");
        await saveSession(page);
        return true;

    } catch (e) {
        console.error(`❌ Login Failed: ${e.message}`);
        return false;
    }
}

// ==========================================
// 3. CRAWLER (UNCHANGED)
// ==========================================
async function crawlCategory(page, categoryUrl) {
    console.log(`\n🕵️ Crawling: ${categoryUrl}`);
    const productSet = new Set();
    let pageNum = 1;
    let keepGoing = true;

    while (keepGoing) {
        const separator = categoryUrl.includes('?') ? '&' : '?';
        const pageUrl = `${categoryUrl}${separator}page=${pageNum}`;
        let links = [];
        let retries = 0;
        const MAX_RETRIES = 3; 

        while (retries < MAX_RETRIES) {
            try {
                const waitType = retries === 0 ? 'domcontentloaded' : 'networkidle2';
                await page.goto(pageUrl, { waitUntil: waitType, timeout: 60000 });
                await wait(2000 + (retries * 1000)); 
                links = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('a[href*="/product/"]'))
                        .map(a => a.href)
                        .filter((v, i, a) => a.indexOf(v) === i);
                });
                if (links.length > 0) break; 
                retries++;
            } catch(e) { retries++; }
        }

        if (links.length === 0) {
            console.log(`\n✅ Page ${pageNum} confirmed empty. Category finished.`);
            keepGoing = false;
        } else {
            const previousSize = productSet.size;
            links.forEach(l => productSet.add(l));
            if (productSet.size === previousSize) {
               keepGoing = false;
            } else {
               process.stdout.write(`\r📄 Page ${pageNum}: Found ${links.length}. Total: ${productSet.size}`);
               pageNum++; 
            }
        }
    }
    return Array.from(productSet);
}

// ==========================================
// 4. EXPERT MINER (✅ SIBLING SCANNER FIX)
// ==========================================
async function analyzeProduct(page, url, categoryName) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForSelector('body', { timeout: 5000 }); } catch(e) {}

        // 1. 🛠️ SCROLL & EXPAND (Fixes Hidden Accordions)
        await page.evaluate(async () => {
            // Scroll down in chunks to trigger lazy loading
            for(let i=0; i<5; i++) {
                window.scrollBy(0, 400);
                await new Promise(r => setTimeout(r, 200));
            }

            const btns = Array.from(document.querySelectorAll('button, h2, h3, h4, div[role="button"]'));
            for (const b of btns) {
                const t = b.innerText.toLowerCase();
                // Click all potential accordion headers
                if (['feature', 'ingredient', 'use', 'description', 'about', 'info', 'benefit'].some(k => t.includes(k))) {
                    b.click();
                    await new Promise(r => setTimeout(r, 50));
                }
            }
        });
        await wait(1000);

        // 2. ⛏️ EXTRACT DATA
        const data = await page.evaluate((categoryName) => {
            const cleanPrice = (str) => {
                const m = str?.match(/[\d,]+\.?\d*/);
                return m ? parseFloat(m[0].replace(/,/g, '')) : 0;
            };

            const txt = document.body.innerText;

            let name = document.querySelector('h1')?.innerText?.trim() || 
                       document.querySelector('.product-name')?.innerText?.trim() ||
                       document.title.split('-')[0].trim();

            let img = document.querySelector('meta[property="og:image"]')?.content;
            if (!img || img.startsWith('data:')) {
                const el = document.querySelector('.product-image img');
                if (el) img = el.getAttribute('data-src') || el.src;
            }
            
            const mrp = cleanPrice(txt.match(/MRP\s*[:\.]*\s*₹?\s*([\d,]+)/i)?.[1]);
            const dp = cleanPrice(txt.match(/(?:S\.P\.|Sale Price)\s*[:\.]*\s*₹?\s*([\d,]+)/i)?.[1]);
            const pv = cleanPrice(txt.match(/(?:P\.V\.|P\.V|PV)\s*[:\.]*\s*([\d,]+)/i)?.[1]);

            // ✅ HELPER: Sibling Scanner (The V41 Magic)
            // Finds the header, then scans next 5 siblings for non-empty text
            const getSecContent = (keywords) => {
                const headers = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, strong, b, div, span'));
                const target = headers.find(el => {
                    const t = el.innerText.trim().toLowerCase();
                    return keywords.some(k => t === k || t === k + ':' || t === k + 's');
                });

                if (target) {
                    let next = target.nextElementSibling;
                    // If no immediate sibling, go to parent's sibling
                    if (!next && target.parentElement) next = target.parentElement.nextElementSibling;

                    // Scan next 3 siblings for content
                    for(let i=0; i<3; i++) {
                        if(next && next.innerText.trim().length > 10) {
                            return next.innerText.trim();
                        }
                        if(next) next = next.nextElementSibling;
                    }
                }
                return "";
            };

            // ✅ Description: Sibling Scan for "About this item"
            let description = getSecContent(['about this item', 'product description']);
            
            // Fallback 1: Try "Description"
            if (!description || description.length < 10) description = getSecContent(['description']);
            
            // Fallback 2: Meta Tag
            if (!description || description.length < 10) description = document.querySelector('meta[name="description"]')?.content || "";
            
            // Safety: Don't allow Name as Description
            if (description.trim() === name.trim()) description = "No description available.";
            
            description = description.slice(0, 5000);

            // ✅ Ingredients & Benefits
            const ingRaw = getSecContent(['key ingredients', 'ingredients', 'composition']);
            const ingredients = ingRaw.split(/[,\n•]/).map(s=>s.trim()).filter(s=>s.length>3);

            const featRaw = getSecContent(['key features', 'features', 'benefits', 'why to choose']);
            const healthBenefits = featRaw.split(/[\n•]/).map(s=>s.trim()).filter(s=>s.length>5);

            const usageRaw = getSecContent(['how to use', 'how to consume', 'usage']);

            const sitePath = Array.from(document.querySelectorAll('.breadcrumb li')).map(e => e.innerText.trim()).join(' > ') || categoryName;

            return {
                name, mrp, dp: dp||mrp, pv, img, 
                description,
                ingredients: ingredients.length ? ingredients : [],
                healthBenefits: healthBenefits.length ? healthBenefits : [],
                usageInfo: { raw: usageRaw },
                sitePath,
                category: categoryName 
            };
        }, categoryName);

        return { ...data, url };
    } catch (e) { return null; }
}

// ==========================================
// 5. ORCHESTRATOR
// ==========================================
async function scrapeAndSave() {
    console.log("\n🚀 [TITAN V41] NUCLEAR CRAWLER STARTING...");
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1366, height: 768 },
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(120000); 

        // Login (Continue even if fails)
        await performExpertLogin(page);
        
        for (const catUrl of CATEGORIES) {
            const categorySlug = catUrl.split('/').pop().replace(/-/g, ' ').toUpperCase();
            const links = await crawlCategory(page, catUrl);
            console.log(`\n🎯 Found ${links.length} products in [${categorySlug}]. Mining...`);

            for (let i = 0; i < links.length; i++) {
                const pData = await analyzeProduct(page, links[i], categorySlug);
                
                if (pData && pData.name && pData.name !== "Unknown Product") {
                    process.stdout.write(`\r💾 [${i+1}/${links.length}] ${pData.name.substring(0, 15)}... | PV:${pData.pv}`);
                    await saveProductSafe(pData);
                } else {
                    console.log(`\n⚠️ Skipped: ${links[i]} (Data Empty)`);
                }
            }
        }
    } catch (e) {
        console.error("🔥 Fatal Error:", e);
    } finally {
        console.log("\n✅ DONE.");
    }
}

module.exports = { scrapeAndSave };