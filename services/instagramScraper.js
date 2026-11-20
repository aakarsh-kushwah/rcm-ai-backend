'use strict';

const axios = require('axios');
const { logger } = require('../utils/logger');

function extractShortcodesFromHtml(html, username, reelsMap) {
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

async function fetchProfileReels(username) {
  const cleanUsername = String(username || '').replace(/^@/, '').trim();
  if (!cleanUsername) return [];

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };

  if (process.env.INSTAGRAM_SESSION_ID) {
    headers.Cookie = `sessionid=${process.env.INSTAGRAM_SESSION_ID.trim()}`;
  }

  const urlsToTry = [
    `https://www.instagram.com/${cleanUsername}/reels/`,
    `https://www.instagram.com/${cleanUsername}/`,
  ];

  const reelsMap = new Map();

  for (const targetUrl of urlsToTry) {
    try {
      const response = await axios.get(targetUrl, {
        headers,
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const html = typeof response.data === 'string' ? response.data : '';
      extractShortcodesFromHtml(html, cleanUsername, reelsMap);

      if (reelsMap.size > 0) {
        break;
      }
    } catch (error) {
      logger.warn(
        `[InstagramScraper] HTTP fetch failed for @${cleanUsername} (${targetUrl}): ${error.message}`
      );
    }
  }

  return Array.from(reelsMap.values());
}

async function fetchReelOEmbed(shortcode) {
  const cleanCode = String(shortcode || '').trim();
  if (!cleanCode) return null;

  try {
    const oembedUrl = `https://api.instagram.com/oembed?url=https://www.instagram.com/reel/${cleanCode}/`;
    const res = await axios.get(oembedUrl, { timeout: 5000 });
    if (res.data) {
      return {
        title: res.data.title || `Instagram Reel ${cleanCode}`,
        thumbnailUrl:
          res.data.thumbnail_url || `https://www.instagram.com/reel/${cleanCode}/media/?size=l`,
        creatorHandle: res.data.author_name || '',
      };
    }
  } catch (err) {
    logger.debug(`[InstagramScraper] oEmbed failed for ${cleanCode}: ${err.message}`);
  }
  return null;
}

module.exports = {
  fetchProfileReels,
  fetchReelOEmbed,
};