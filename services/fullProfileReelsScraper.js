
/**
 * @file rcm-ai-backend/services/fullProfileReelsScraper.js
 * @description Unlimited Instagram profile reels scraper using Puppeteer infinite scroll pagination & dynamic API extraction with zero mock arrays.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');
const { logger } = require('../utils/logger');

/**
 * Exhaustively scrapes all reels from a public Instagram profile using infinite scroll pagination.
 * @param {string} username - Instagram account handle (without @)
 * @param {Object} options - Options object { accountId, category }
 * @returns {Promise<Array>} Array of normalized reel objects
 */
async function fetchFullProfileReels(username, options = {}) {
  const { accountId = null, category = 'Motivation' } = options;
  const cleanUsername = String(username || '').replace(/^@/, '').trim();
  if (!cleanUsername) {
    logger.warn('[FullProfileReelsScraper] Invalid username provided.');
    return [];
  }

  logger.info(`[FullProfileReelsScraper] Starting unlimited scraper for @${cleanUsername}...`);
  let reelsMap = new Map();
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

    // Intercept responses to catch GraphQL / Clips API payload packets & direct video responses
    page.on('response', async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('video/mp4') || (url.includes('.mp4') && url.includes('cdninstagram.com'))) {
          for (const [shortcode, reel] of reelsMap.entries()) {
            if (!reel.videoUrl) {
              reel.videoUrl = url;
              break;
            }
          }
        }
        if (url.includes('/graphql/query') || url.includes('/api/v1/clips') || url.includes('clips/tab') || url.includes('graphql')) {
          if (contentType.includes('application/json')) {
            const data = await response.json();
            extractReelsFromJson(data, cleanUsername, reelsMap);
          }
        }
      } catch (err) {
        // Ignore response parse errors
      }
    });

    const profileUrl = `https://www.instagram.com/${cleanUsername}/reels/`;
    logger.info(`[FullProfileReelsScraper] Navigating to ${profileUrl}`);
    
    const sessionId = process.env.INSTAGRAM_SESSION_ID;
    if (sessionId) {
      await page.setCookie({
        name: 'sessionid',
        value: sessionId,
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true
      });
      logger.info(`[FullProfileReelsScraper] Injected INSTAGRAM_SESSION_ID cookie for authenticated request.`);
    }

    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((res) => setTimeout(res, 3000));

    // Infinite scroll loop until no new reels or max attempts reached
    let previousReelCount = 0;
    let consecutiveNoNewReels = 0;
    const maxScrollAttempts = 50; // Safeguard against infinite loops

    for (let scrollAttempt = 1; scrollAttempt <= maxScrollAttempts; scrollAttempt++) {
      // Extract shortcodes and data from current DOM HTML as well
      const pageHtml = await page.content();
      extractReelsFromHtml(pageHtml, cleanUsername, reelsMap);

      const currentCount = reelsMap.size;
      logger.info(`[FullProfileReelsScraper] @${cleanUsername} - Scroll ${scrollAttempt}: found ${currentCount} unique reels so far.`);

      if (currentCount === previousReelCount) {
        consecutiveNoNewReels++;
        if (consecutiveNoNewReels >= 3) {
          logger.info(`[FullProfileReelsScraper] Reached end of archive for @${cleanUsername} after 3 consecutive scrolls with no new reels.`);
          break;
        }
      } else {
        consecutiveNoNewReels = 0;
        previousReelCount = currentCount;
      }

      // Scroll down
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise((res) => setTimeout(res, 2500));
    }

    await browser.close();
    browser = null;
  } catch (puppeteerErr) {
    logger.warn(`[FullProfileReelsScraper] Puppeteer scraping encountered issue for @${cleanUsername}: ${puppeteerErr.message}. Falling back to Axios HTTP parsing.`);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }

    // Fallback Axios scraping
    try {
      const fallbackReels = await fetchProfileReelsAxios(cleanUsername);
      fallbackReels.forEach(r => reelsMap.set(r.shortcode, r));
    } catch (fallbackErr) {
      logger.error(`[FullProfileReelsScraper] Axios fallback failed for @${cleanUsername}: ${fallbackErr.message}`);
    }
  }

  const finalReels = Array.from(reelsMap.values()).map(reel => ({
    shortcode: reel.shortcode,
    url: reel.url || `https://www.instagram.com/reel/${reel.shortcode}/`,
    thumbnailUrl: reel.thumbnailUrl || `https://www.instagram.com/reel/${reel.shortcode}/media/?size=l`,
    videoUrl: reel.videoUrl || null,
    title: String(reel.title || `Instagram Reel ${reel.shortcode}`).trim().slice(0, 500),
    creatorHandle: cleanUsername,
    category: category,
    accountId: accountId || null,
    isActive: true,
  }));

  logger.info(`[FullProfileReelsScraper] Successfully scraped ${finalReels.length} unique reels for @${cleanUsername}.`);
  return finalReels;
}

/**
 * Helper to recursively extract reels from JSON payloads
 */
function extractReelsFromJson(obj, username, reelsMap) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractReelsFromJson(item, username, reelsMap);
    }
    return;
  }

  // Check if object is a media node containing shortcode or code
  const shortcode = obj.shortcode || obj.code;
  if (shortcode && typeof shortcode === 'string' && shortcode.length >= 5) {
    const caption = obj.title || (obj.edge_media_to_caption?.edges?.[0]?.node?.text) || obj.caption?.text || '';
    const thumbnailUrl = obj.thumbnail_src || obj.display_url || obj.thumbnailUrl || '';
    const videoUrl = obj.video_url || obj.videoUrl || obj.video_versions?.[0]?.url || obj.edge_media_to_parent_video?.video_url || '';
    const existing = reelsMap.get(shortcode) || {};
    reelsMap.set(shortcode, {
      shortcode,
      url: `https://www.instagram.com/reel/${shortcode}/`,
      thumbnailUrl: thumbnailUrl || existing.thumbnailUrl,
      videoUrl: (videoUrl && (videoUrl.includes('.mp4') || videoUrl.includes('cdninstagram.com')) ? videoUrl : '') || existing.videoUrl,
      title: caption || existing.title || `Instagram Reel ${shortcode}`,
      creatorHandle: username,
    });
  }

  if (obj.video_url && obj.shortcode) {
    const existing = reelsMap.get(obj.shortcode) || {};
    if (obj.video_url.includes('.mp4') || obj.video_url.includes('cdninstagram.com')) {
      existing.videoUrl = obj.video_url;
      reelsMap.set(obj.shortcode, existing);
    }
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      extractReelsFromJson(obj[key], username, reelsMap);
    }
  }
}

/**
 * Helper to extract shortcodes from HTML string via regex
 */
function extractReelsFromHtml(html, username, reelsMap) {
  if (!html || typeof html !== 'string') return;

  // Regex matching /reel/shortcode or /p/shortcode
  const regex = /\/(?:reel|p)\/([A-Za-z0-9_-]{10,13})\//g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const shortcode = match[1];
    if (!reelsMap.has(shortcode)) {
      reelsMap.set(shortcode, {
        shortcode,
        url: `https://www.instagram.com/reel/${shortcode}/`,
        thumbnailUrl: `https://www.instagram.com/reel/${shortcode}/media/?size=l`,
        title: `Instagram Reel ${shortcode}`,
        creatorHandle: username,
      });
    }
  }
}

/**
 * Fallback Axios profile fetcher
 */
async function fetchProfileReelsAxios(username) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (process.env.INSTAGRAM_SESSION_ID) {
    headers['Cookie'] = `sessionid=${process.env.INSTAGRAM_SESSION_ID.trim()}`;
  }

  const res = await axios.get(`https://www.instagram.com/${username}/reels/`, { headers, timeout: 15000 });
  const html = typeof res.data === 'string' ? res.data : '';
  const reelsMap = new Map();
  extractReelsFromHtml(html, username, reelsMap);
  return Array.from(reelsMap.values());
}

module.exports = {
  fetchFullProfileReels,
};
