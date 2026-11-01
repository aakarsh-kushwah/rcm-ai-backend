/**
 * @file services/rcmScraper.js
 * @description TITAN V45.0: MEGA MERGE (Sibling Scanner + Cloudinary Sync + Socket Progress)
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { Product } = require('../models');
const { uploadProductImage } = require('./cloudinaryService');
const { emitProgress } = require('./socketService');
const { createRcmSession } = require('./rcmSessionService');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const BASE_URL = 'https://www.rcmworld.com';
const SESSION_FILE = path.join(__dirname, 'rcm_session.json');

// ✅ SAARI CATEGORIES WAPAS ADD KAR DI HAIN
const CATEGORIES = [
    `${BASE_URL}/category/food-grocery`,
    `${BASE_URL}/category/personal-care`,
    `${BASE_URL}/category/health-care`,
    `${BASE_URL}/category/kid-s-wear`,
    `${BASE_URL}/category/luggage-bags`,
    `${BASE_URL}/category/electronics`,
    `${BASE_URL}/category/paints-construction`,
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
    } catch (e) {
        logger.error({ error: e.message }, "Error saving session");
    }
}

async function loadSession(page) {
    if (fs.existsSync(SESSION_FILE)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(SESSION_FILE));
            await page.setCookie(...cookies);
            return true;
        } catch (e) {
            logger.error({ error: e.message }, "Error loading session");
        }
    }
    return false;
}

// 🔥 CLOUDINARY + TiDB SYNC (No Base64 Allowed)
async function saveProductSafe(data) {
    let retries = 3;
    let finalImageUrl = null;
    let cloudinarySuccess = false;

    if (data.img && !data.img.startsWith('data:') && !data.img.includes('placeholder')) {
        try {
            const cdnUrl = await uploadProductImage(data.img, data.name);
            if (cdnUrl) {
                finalImageUrl = cdnUrl;
                cloudinarySuccess = true;
            }
        } catch (err) {
            logger.warn({ productName: data.name, error: err.message }, "Cloudinary Sync failed");
        }
    }

    while(retries > 0) {
        try {
            const finalCategory = (data.category && data.category !== '') ? data.category : 'RCM-General';
            let smartTags = [`rcm-${finalCategory}`.replace(/\s+/g, '-' ).toLowerCase()];
            if(data.ingredients?.length > 0) smartTags.push(...data.ingredients.slice(0, 3));

            await Product.upsert({
                productUrl: data.url,
                name: data.name,
                description: data.description, 
                mrp: data.mrp,
                dp: data.dp || data.mrp,
                pv: data.pv,
                imageUrl: finalImageUrl, // ✅ TiDB gets Cloudinary URL
                sitePath: data.sitePath,
                ingredients: data.ingredients, 
                healthBenefits: data.healthBenefits, 
                usageInfo: data.usageInfo,
                category: finalCategory,
                aiTags: smartTags
            });
            return { cloudinarySuccess, dbSuccess: true };
        } catch (e) {
            logger.warn({ productName: data.name, error: e.message }, "DB Error. Retrying...");
            retries--;
            await wait(2000); 
        }
    }
    logger.error({ productName: data.name }, "Failed to save product to DB.");
    return { cloudinarySuccess, dbSuccess: false };
}

// ==========================================
// 2. BULLETPROOF LOGIN (V45)
// ==========================================
async function performExpertLogin(page) {
    logger.info("Starting Secure Login Sequence...");
    const buyerId = process.env.RCM_SCRAPER_ID || process.env.RCM_USERNAME || process.env.RCM_BUYER_ID;
    const password = process.env.RCM_SCRAPER_PASS || process.env.RCM_PASSWORD;

    if (!buyerId || !password) {
        logger.error("RCM scraper credentials are missing from environment variables.");
        return false;
    }

    try {
        const session = createRcmSession({
            buyerId,
            password,
            options: {
                baseUrl: BASE_URL,
                timeout: 20000,
                requestDelayMin: 400,
                requestDelayMax: 800,
                maxRetries: 2,
                retryBackoffMs: 500,
                maxConcurrency: 1
            }
        });

        const loggedIn = await session.login();
        if (!loggedIn) {
            logger.warn("RCM session service reported login was not successful.");
            return false;
        }

        const authCookies = await session.jar.getCookies(baseUrl);
        const sessionCookieData = authCookies.map((cookie) => ({
            name: cookie.key || cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite
        }));

        await page.setCookie(...sessionCookieData.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            expires: typeof cookie.expires === 'number' ? cookie.expires : undefined,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite || 'Lax'
        })));
        await page.goto(`${BASE_URL}/my-account`, { waitUntil: 'networkidle2', timeout: 90000 });
        logger.info("Login Success.");
        session.close();
        return true;
    } catch (e) {
        logger.error({ error: e.message }, "Login Failed");
        return false;
    }
}

// ==========================================
// 3. EXPERT MINER (SIBLING SCANNER + IMAGE RADAR)
// ==========================================
async function analyzeProduct(page, url, categoryName) {
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        await page.evaluate(async () => {
            window.scrollBy(0, 500); await new Promise(r => setTimeout(r, 800));
            // Trigger Accordions (Ingredients/Features)
            const btns = Array.from(document.querySelectorAll('button, h2, h3, h4, div[role="button"]'));
            for (const b of btns) {
                const t = b.innerText.toLowerCase();
                if (['feature', 'ingredient', 'use', 'description', 'benefit'].some(k => t.includes(k))) b.click();
            }
            window.scrollTo(0, 0);
        });

        // 🎯 IMAGE RADAR: Wait for Real Image
        let realImg = '';
        for(let i=0; i<5; i++) {
            realImg = await page.evaluate(() => {
                const el = document.querySelector(' .product-image img, #zoom_01, [data-zoom-image], .img-responsive');
                const src = el?.getAttribute('data-zoom-image') || el?.getAttribute('data-src') || el?.src;
                return (src && !src.startsWith('data:') && !src.includes('placeholder')) ? src : '';
            });
            if (realImg) break;
            await wait(2000);
        }

        const data = await page.evaluate((categoryName) => {
            const clean = (s) => s ? parseFloat(s.replace(/,/g, '').match(/\d+/)?.[0] || 0) : 0;
            const txt = document.body.innerText;
            const name = document.querySelector('h1')?.innerText?.trim() || 'Unknown Product';

            // ✅ Sibling Scanner Logic (V41 Style)
            const getSecContent = (keywords) => {
                const headers = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, strong, b, div, span'));
                const target = headers.find(el => {
                    const t = el.innerText.trim().toLowerCase();
                    return keywords.some(k => t === k || t === k + ':' || t === k + 's');
                });
                if (target) {
                    let next = target.nextElementSibling || target.parentElement.nextElementSibling;
                    for(let i=0; i<3; i++) {
                        if(next && next.innerText.trim().length > 10) return next.innerText.trim();
                        if(next) next = next.nextElementSibling;
                    }
                }
                return '';
            };

            const mrp = clean(txt.match(/MRP\s*[:\.]*\s*₹?\s*([\d,]+)/i)?.[1]);
            const dp = clean(txt.match(/(?:S\.P\.|SP|Sale Price)\s*[:\.]*\s*₹?\s*([\d,]+)/i)?.[1]);
            const pv = clean(txt.match(/(?:P\.V\.|PV)\s*[:\.]*\s*(\d+)/i)?.[1]);

            return {
                name, mrp, dp: dp || mrp, pv,
                description: getSecContent(['about this item', 'description']) || txt.substring(0, 800),
                ingredients: getSecContent(['ingredients']).split(/[,\n•]/).map(s=>s.trim()).filter(s=>s.length>3),
                healthBenefits: getSecContent(['features', 'benefits']).split(/\n•/).map(s=>s.trim()).filter(s=>s.length>5),
                usageInfo: { raw: getSecContent(['how to use', 'usage']) },
                sitePath: Array.from(document.querySelectorAll(' .breadcrumb li')).map(e => e.innerText.trim()).join(' > ') || categoryName,
                category: categoryName
            };
        }, categoryName);

        return { ...data, img: realImg, url };
    } catch (e) {
        logger.error({ url, categoryName, error: e.message }, "Error analyzing product");
        return null; 
    }
}

// ==========================================
// 4. MAIN ENGINE
// ==========================================
async function scrapeAndSave() {
    logger.info("UNIFIED SYNC ENGINE STARTING...");
    emitProgress('syncProgress', { status: 'starting', message: 'Engine Ignited.' });

    const browser = await puppeteer.launch({ 
        headless: "new", 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-gpu'] 
    });

    try {
        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(120000); 

        await performExpertLogin(page);
        
        for (const catUrl of CATEGORIES) {
            const categorySlug = catUrl.split('/').pop().toUpperCase();
            logger.info({ category: categorySlug }, `Mining Category: ${categorySlug}`);
            emitProgress('syncProgress', { status: 'crawling', message: `Scanning ${categorySlug}` });
            
            await page.goto(catUrl, { waitUntil: 'networkidle2' });
            const links = await page.evaluate(() => 
                [...new Set(Array.from(document.querySelectorAll('a[href*="/product/"]')).map(a => a.href))]
            );
            
            logger.info({ category: categorySlug, count: links.length }, "Products found in category");

            for (let i = 0; i < links.length; i++) {
                const pData = await analyzeProduct(page, links[i], categorySlug);
                if (pData && pData.name !== "Unknown Product") {
                    const { cloudinarySuccess, dbSuccess } = await saveProductSafe(pData);
                    
                    emitProgress('syncProgress', { 
                        status: 'syncing', 
                        productName: pData.name,
                        processed: i + 1,
                        total: links.length,
                        cloudinary: cloudinarySuccess,
                        db: dbSuccess
                    });

                    logger.info({ productName: pData.name, pv: pData.pv, cloudinarySuccess, dbSuccess }, `Product scraped and saved: ${pData.name.substring(0, 30)}...`);
                } else {
                    logger.warn({ url: links[i] }, "Skipped product: Data Empty or Unknown Product");
                }
                await wait(2000); 
            }
        }
    } catch (e) {
        logger.error({ error: e.message, stack: e.stack }, "Fatal Error during scraping");
        emitProgress('syncProgress', { status: 'error', message: e.message });
    } finally {
        await browser.close();
        emitProgress('syncProgress', { status: 'complete', message: 'Master Sync Complete.' });
        logger.info("MEGA SYNC COMPLETE.");
    }
}

module.exports = { scrapeAndSave };
