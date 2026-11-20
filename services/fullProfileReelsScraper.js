'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const axios = require('axios');
const { Op } = require('sequelize');
const { logger } = require('../utils/logger');
const { InstagramReel } = require('../models');

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

function resolveBrowserExecutable() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // Ignore invalid path check
    }
  }
  return undefined; // Let Puppeteer use its bundled browser if present
}

function getLaunchOptions() {
  const executablePath = resolveBrowserExecutable();
  const opts = {
    headless: 'new',
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,800',
    ],
  };
  if (executablePath) {
    opts.executablePath = executablePath;
  }
  return opts;
}

/**
 * Scrapes reels from an Instagram profile.
 * - mode: 'full' (thorough scroll for new / 0-reel accounts)
 * - mode: 'incremental' (top scrolls + early stop once consecutive known reels are found)
 */
async function fetchFullProfileReels(username, options = {}) {
  const {
    accountId = null,
    category = 'Motivation',
    mode = 'full',
    onProgress = null,
  } = options;

  const cleanUsername = String(username || '').replace(/^@/, '').trim();
  if (!cleanUsername) {
    logger.warn('[FullProfileReelsScraper] Invalid username provided.');
    return [];
  }

  const isIncremental = mode === 'incremental';
  const maxScrollAttempts = isIncremental ? 4 : 50;
  const earlyStopThreshold = isIncremental ? 2 : 4;

  logger.info(
    `[FullProfileReelsScraper] Starting ${mode.toUpperCase()} scraper for @${cleanUsername}...`
  );

  const reelsMap = new Map();
  let browser = null;

  try {
    const launchOpts = getLaunchOptions();
    browser = await puppeteer.launch(launchOpts);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );

    // Block heavy non-essential images/fonts/media to keep RAM & bandwidth low
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        if (
          url.includes('/graphql/query') ||
          url.includes('/api/v1/clips') ||
          url.includes('clips/tab') ||
          url.includes('graphql')
        ) {
          if (contentType.includes('application/json')) {
            const data = await response.json();
            extractReelsFromJson(data, cleanUsername, reelsMap);
          }
        }
      } catch (_) {
        // Ignore non-JSON or closed target responses
      }
    });

    const profileUrl = `https://www.instagram.com/${cleanUsername}/reels/`;
    logger.info(`[FullProfileReelsScraper] Navigating to ${profileUrl}`);

    const sessionId = process.env.INSTAGRAM_SESSION_ID;
    if (sessionId) {
      await page.setCookie({
        name: 'sessionid',
        value: sessionId.trim(),
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true,
      });
    }

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((res) => setTimeout(res, 2500));

    let previousReelCount = 0;
    let consecutiveNoNewReels = 0;
    let consecutiveKnownBatches = 0;

    for (let scrollAttempt = 1; scrollAttempt <= maxScrollAttempts; scrollAttempt++) {
      const beforeSize = reelsMap.size;
      const pageHtml = await page.content();
      const batchShortcodes = new Set();
      extractReelsFromHtml(pageHtml, cleanUsername, reelsMap, batchShortcodes);

      const newlyAddedCodes = Array.from(batchShortcodes).filter((sc) => {
        const item = reelsMap.get(sc);
        return item && !item._seenInEarlierScroll;
      });

      if (newlyAddedCodes.length > 0 && InstagramReel) {
        const existingInDb = await InstagramReel.findAll({
          where: { shortcode: { [Op.in]: newlyAddedCodes } },
          attributes: ['shortcode'],
        });
        const dbSet = new Set(existingInDb.map((r) => String(r.shortcode)));
        const allAlreadyInDb = newlyAddedCodes.every((code) => dbSet.has(code));

        if (allAlreadyInDb) {
          consecutiveKnownBatches += 1;
          if (isIncremental && consecutiveKnownBatches >= earlyStopThreshold) {
            logger.info(
              `[FullProfileReelsScraper] Incremental early stop for @${cleanUsername}: ${consecutiveKnownBatches} batches already in DB.`
            );
            break;
          }
        } else {
          consecutiveKnownBatches = 0;
        }
      }

      newlyAddedCodes.forEach((sc) => {
        const item = reelsMap.get(sc);
        if (item) item._seenInEarlierScroll = true;
      });

      const currentCount = reelsMap.size;
      logger.info(
        `[FullProfileReelsScraper] @${cleanUsername} [${mode}] - Scroll ${scrollAttempt}/${maxScrollAttempts}: ${currentCount} unique reels.`
      );

      if (typeof onProgress === 'function') {
        try {
          onProgress({
            username: cleanUsername,
            scroll: scrollAttempt,
            maxScrolls: maxScrollAttempts,
            scrapedCount: currentCount,
            mode,
          });
        } catch (_) {}
      }

      if (currentCount === previousReelCount && currentCount === beforeSize) {
        consecutiveNoNewReels += 1;
        if (consecutiveNoNewReels >= 3) {
          logger.info(
            `[FullProfileReelsScraper] Reached end of archive for @${cleanUsername} after 3 empty scrolls.`
          );
          break;
        }
      } else {
        consecutiveNoNewReels = 0;
        previousReelCount = currentCount;
      }

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise((res) => setTimeout(res, 2200));
    }
  } catch (puppeteerErr) {
    logger.warn(
      `[FullProfileReelsScraper] Puppeteer issue for @${cleanUsername}: ${puppeteerErr.message}. Trying HTTP fallback...`
    );
    try {
      const fallbackReels = await fetchProfileReelsAxios(cleanUsername);
      fallbackReels.forEach((r) => {
        if (!reelsMap.has(r.shortcode)) reelsMap.set(r.shortcode, r);
      });
    } catch (fallbackErr) {
      logger.error(
        `[FullProfileReelsScraper] HTTP fallback failed for @${cleanUsername}: ${fallbackErr.message}`
      );
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
      browser = null;
    }
  }

  const finalReels = Array.from(reelsMap.values()).map((reel) => ({
    shortcode: reel.shortcode,
    url: reel.url || `https://www.instagram.com/reel/${reel.shortcode}/`,
    thumbnailUrl:
      reel.thumbnailUrl || `https://www.instagram.com/reel/${reel.shortcode}/media/?size=l`,
    videoUrl: reel.videoUrl || null,
    title: String(reel.title || `Instagram Reel ${reel.shortcode}`).trim().slice(0, 500),
    creatorHandle: cleanUsername,
    category,
    accountId: accountId || null,
    isActive: true,
  }));

  logger.info(
    `[FullProfileReelsScraper] Finished @${cleanUsername}: ${finalReels.length} unique reels (${mode}).`
  );
  return finalReels;
}

function extractReelsFromJson(obj, username, reelsMap) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractReelsFromJson(item, username, reelsMap);
    }
    return;
  }

  const rawCode = obj.shortcode || obj.code;
  if (rawCode && typeof rawCode === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(rawCode)) {
    const caption =
      obj.title ||
      obj.edge_media_to_caption?.edges?.[0]?.node?.text ||
      obj.caption?.text ||
      '';
    const thumbnailUrl = obj.thumbnail_src || obj.display_url || obj.thumbnailUrl || '';
    const rawVideo =
      obj.video_url ||
      obj.videoUrl ||
      obj.video_versions?.[0]?.url ||
      obj.edge_media_to_parent_video?.video_url ||
      '';
    const validVideoUrl =
      rawVideo && (rawVideo.includes('.mp4') || rawVideo.includes('cdninstagram.com'))
        ? rawVideo
        : null;

    const existing = reelsMap.get(rawCode) || {};
    reelsMap.set(rawCode, {
      ...existing,
      shortcode: rawCode,
      url: existing.url || `https://www.instagram.com/reel/${rawCode}/`,
      thumbnailUrl: thumbnailUrl || existing.thumbnailUrl,
      videoUrl: validVideoUrl || existing.videoUrl || null,
      title: caption || existing.title || `Instagram Reel ${rawCode}`,
      creatorHandle: username,
    });
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      extractReelsFromJson(obj[key], username, reelsMap);
    }
  }
}

function extractReelsFromHtml(html, username, reelsMap, batchShortcodes = new Set()) {
  if (!html || typeof html !== 'string') return;

  const regex = /\/(?:reel|reels|p)\/([A-Za-z0-9_-]{8,16})\//g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const shortcode = match[1];
    batchShortcodes.add(shortcode);
    if (!reelsMap.has(shortcode)) {
      reelsMap.set(shortcode, {
        shortcode,
        url: `https://www.instagram.com/reel/${shortcode}/`,
        thumbnailUrl: `https://www.instagram.com/reel/${shortcode}/media/?size=l`,
        videoUrl: null,
        title: `Instagram Reel ${shortcode}`,
        creatorHandle: username,
      });
    }
  }
}

async function fetchProfileReelsAxios(username) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (process.env.INSTAGRAM_SESSION_ID) {
    headers.Cookie = `sessionid=${process.env.INSTAGRAM_SESSION_ID.trim()}`;
  }

  const res = await axios.get(`https://www.instagram.com/${username}/reels/`, {
    headers,
    timeout: 15000,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const html = typeof res.data === 'string' ? res.data : '';
  const reelsMap = new Map();
  extractReelsFromHtml(html, username, reelsMap);
  return Array.from(reelsMap.values());
}

module.exports = {
  fetchFullProfileReels,
};