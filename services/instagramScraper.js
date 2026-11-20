'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const { logger } = require('../utils/logger');
const { InstagramReel } = require('../models');

async function fetchProfileReels(username) {
  const cleanUsername = String(username || '').replace(/^@/, '').trim();
  if (!cleanUsername) return [];

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  if (process.env.INSTAGRAM_SESSION_ID) {
    headers.Cookie = `sessionid=${process.env.INSTAGRAM_SESSION_ID.trim()}`;
  }

  let html = '';
  try {
    const response = await axios.get(`https://www.instagram.com/${cleanUsername}/reels/`, {
      headers,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    html = typeof response.data === 'string' ? response.data : '';
  } catch (error) {
    logger.warn(`[InstagramScraper] HTTP fetch failed for @${cleanUsername}: ${error.message}`);
    return [];
  }

  const reelsMap = new Map();
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
        creatorHandle: cleanUsername,
      });
    }
  }

  const uniqueReels = Array.from(reelsMap.values());
  if (uniqueReels.length === 0 || !InstagramReel) return uniqueReels;

  const shortcodes = uniqueReels.map((r) => r.shortcode);
  const existingRows = await InstagramReel.findAll({
    where: { shortcode: { [Op.in]: shortcodes } },
    attributes: ['shortcode'],
  });
  const existingSet = new Set(existingRows.map((r) => String(r.shortcode)));

  return uniqueReels.filter((r) => !existingSet.has(r.shortcode));
}

async function fetchReelOEmbed(shortcode) {
  try {
    const oembedUrl = `https://api.instagram.com/oembed?url=https://www.instagram.com/reel/${shortcode}/`;
    const res = await axios.get(oembedUrl, { timeout: 5000 });
    if (res.data) {
      return {
        title: res.data.title || `Instagram Reel ${shortcode}`,
        thumbnailUrl:
          res.data.thumbnail_url || `https://www.instagram.com/reel/${shortcode}/media/?size=l`,
        creatorHandle: res.data.author_name || '',
      };
    }
  } catch (err) {
    logger.debug(`[InstagramScraper] oEmbed failed for ${shortcode}: ${err.message}`);
  }
  return null;
}

module.exports = {
  fetchProfileReels,
  fetchReelOEmbed,
};