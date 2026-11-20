'use strict';

const fs = require('fs');
const axios = require('axios');
const { Op } = require('sequelize');
const { logger } = require('../utils/logger');
const { InstagramReel } = require('../models');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Set DISABLE_BROWSER_SCRAPER=false in env only if you explicitly want Puppeteer/Chromium
const USE_BROWSER =
  String(process.env.DISABLE_BROWSER_SCRAPER || 'true').trim().toLowerCase() === 'false';

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
  return undefined;
}

function buildHttpHeaders() {
  const headers = {
    'User-Agent': DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-IG-App-ID': '936619743392459',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (process.env.INSTAGRAM_SESSION_ID) {
    headers.Cookie = `sessionid=${process.env.INSTAGRAM_SESSION_ID.trim()}`;
  }
  return headers;
}

/**
 * Scrapes reels from an Instagram profile without needing a headless browser by default.
 * - mode: 'full' (thorough HTTP extraction for new / 0-reel accounts)
 * - mode: 'incremental' (quick check + early stop if reels already exist in DB)
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
  const maxSteps = isIncremental ? 2 : 3;

  logger.info(
    `[FullProfileReelsScraper] Starting ${mode.toUpperCase()} HTTP scraper for @${cleanUsername} (browser=${USE_BROWSER})...`
  );

  const reelsMap = new Map();

  try {
    const httpReels = await fetchProfileReelsHttp(cleanUsername, {
      mode,
      maxSteps,
      onProgress,
    });
    for (const r of httpReels) {
      if (!reelsMap.has(r.shortcode)) {
        reelsMap.set(r.shortcode, r);
      } else {
        reelsMap.set(r.shortcode, { ...reelsMap.get(r.shortcode), ...r });
      }
    }
  } catch (httpErr) {
    logger.warn(
      `[FullProfileReelsScraper] HTTP scrape warning for @${cleanUsername}: ${httpErr.message}`
    );
  }

  // If HTTP got nothing and browser mode is explicitly enabled, try Puppeteer
  if (reelsMap.size === 0 && USE_BROWSER) {
    try {
      const browserReels = await fetchProfileReelsPuppeteer(cleanUsername, {
        mode,
        onProgress,
      });
      for (const r of browserReels) {
        if (!reelsMap.has(r.shortcode)) reelsMap.set(r.shortcode, r);
      }
    } catch (browserErr) {
      logger.warn(
        `[FullProfileReelsScraper] Browser fallback failed for @${cleanUsername}: ${browserErr.message}`
      );
    }
  }

  // In incremental mode, if we already have plenty of these shortcodes in DB, note it cleanly
  if (isIncremental && reelsMap.size > 0 && InstagramReel) {
    try {
      const codes = Array.from(reelsMap.keys()).slice(0, 30);
      const existing = await InstagramReel.findAll({
        where: { shortcode: { [Op.in]: codes } },
        attributes: ['shortcode'],
      });
      logger.info(
        `[FullProfileReelsScraper] Incremental check @${cleanUsername}: ${existing.length}/${codes.length} sampled shortcodes already in DB.`
      );
    } catch (_) {
      // Non-fatal DB check error
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

async function fetchProfileReelsHttp(username, { mode, maxSteps, onProgress }) {
  const headers = buildHttpHeaders();
  const reelsMap = new Map();

  const targets = [
    {
      label: 'web_profile_info',
      url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
        username
      )}`,
      isJson: true,
    },
    {
      label: 'reels_page',
      url: `https://www.instagram.com/${encodeURIComponent(username)}/reels/`,
      isJson: false,
    },
    ...(mode === 'full'
      ? [
          {
            label: 'profile_page',
            url: `https://www.instagram.com/${encodeURIComponent(username)}/`,
            isJson: false,
          },
        ]
      : []),
  ].slice(0, maxSteps);

  for (let i = 0; i < targets.length; i++) {
    const step = i + 1;
    const target = targets[i];

    try {
      const res = await axios.get(target.url, {
        headers: {
          ...headers,
          Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
        },
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      if (target.isJson && res.data && typeof res.data === 'object') {
        extractReelsFromJson(res.data, username, reelsMap);
      } else if (typeof res.data === 'string' && res.data.length > 0) {
        extractReelsFromHtml(res.data, username, reelsMap);
        extractEmbeddedJsonReels(res.data, username, reelsMap);
      }
    } catch (err) {
      logger.warn(
        `[FullProfileReelsScraper] Step ${step} (${target.label}) failed for @${username}: ${err.message}`
      );
    }

    if (typeof onProgress === 'function') {
      try {
        onProgress({
          username,
          scroll: step,
          maxScrolls: targets.length,
          scrapedCount: reelsMap.size,
          mode,
        });
      } catch (_) {}
    }

    // Small polite pause between HTTP requests
    if (i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  return Array.from(reelsMap.values());
}

async function fetchProfileReelsPuppeteer(username, { mode, onProgress }) {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());

  const executablePath = resolveBrowserExecutable();
  const launchOpts = {
    headless: 'new',
    protocolTimeout: 180000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,800',
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;

  const maxScrolls = mode === 'incremental' ? 3 : 12;
  const reelsMap = new Map();
  let browser = null;

  try {
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(DEFAULT_UA);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if (
          ct.includes('application/json') &&
          (url.includes('/graphql') || url.includes('/api/v1/clips') || url.includes('clips/tab'))
        ) {
          const json = await response.json();
          extractReelsFromJson(json, username, reelsMap);
        }
      } catch (_) {}
    });

    if (process.env.INSTAGRAM_SESSION_ID) {
      await page.setCookie({
        name: 'sessionid',
        value: process.env.INSTAGRAM_SESSION_ID.trim(),
        domain: '.instagram.com',
        path: '/',
        httpOnly: true,
        secure: true,
      });
    }

    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/reels/`, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    });
    await new Promise((r) => setTimeout(r, 2000));

    let prevCount = 0;
    let idleStreak = 0;

    for (let s = 1; s <= maxScrolls; s++) {
      const html = await page.content();
      extractReelsFromHtml(html, username, reelsMap);
      extractEmbeddedJsonReels(html, username, reelsMap);

      if (typeof onProgress === 'function') {
        try {
          onProgress({
            username,
            scroll: s,
            maxScrolls,
            scrapedCount: reelsMap.size,
            mode,
          });
        } catch (_) {}
      }

      if (reelsMap.size === prevCount) {
        idleStreak += 1;
        if (idleStreak >= 2) break;
      } else {
        idleStreak = 0;
        prevCount = reelsMap.size;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 2000));
    }

    return Array.from(reelsMap.values());
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }
}

function extractEmbeddedJsonReels(html, username, reelsMap) {
  if (!html || typeof html !== 'string') return;
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = (match[1] || '').trim();
    if (!raw || raw.length > 2000000) continue;
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        extractReelsFromJson(JSON.parse(raw), username, reelsMap);
      } catch (_) {}
    }
  }
}

function extractReelsFromJson(obj, username, reelsMap, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      extractReelsFromJson(obj[i], username, reelsMap, depth + 1);
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
    const val = obj[key];
    if (val && typeof val === 'object') {
      extractReelsFromJson(val, username, reelsMap, depth + 1);
    }
  }
}

function extractReelsFromHtml(html, username, reelsMap) {
  if (!html || typeof html !== 'string') return;

  const regex = /\/(?:reel|reels|p)\/([A-Za-z0-9_-]{8,16})\//g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const shortcode = match[1];
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

module.exports = {
  fetchFullProfileReels,
};