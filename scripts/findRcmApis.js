const axios = require('axios');
const cheerio = require('cheerio');

(async () => {
  try {
    console.log("1. Fetching page scripts from rcmworld.com...");
    const pages = [
      'https://www.rcmworld.com/my-account/identity-card',
      'https://www.rcmworld.com/my-account/your-group'
    ];

    const scriptUrls = new Set();

    for (const pageUrl of pages) {
      const res = await axios.get(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const $ = cheerio.load(res.data);
      $('script[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && (src.includes('pages') || src.includes('chunks') || src.includes('my-account'))) {
          scriptUrls.add(src.startsWith('http') ? src : `https://www.rcmworld.com${src}`);
        }
      });
    }

    console.log(`Found ${scriptUrls.size} frontend script files. Scanning for API routes...\n`);

    const foundApis = new Set();

    for (const scriptUrl of scriptUrls) {
      try {
        const sRes = await axios.get(scriptUrl, { timeout: 10000 });
        const code = String(sRes.data);

        // Match all ecomapi and internal API patterns
        const matches = code.match(/https:\/\/ecomapi\.rcmworld\.com\/api\/[a-zA-Z0-9_\-\/]+/g) || [];
        matches.forEach(m => foundApis.add(m));

        const relativeMatches = code.match(/\/api\/(?:generic|user|account|group|tree|distributor)[a-zA-Z0-9_\-\/]*/g) || [];
        relativeMatches.forEach(m => foundApis.add(`https://ecomapi.rcmworld.com${m}`));
      } catch (err) {}
    }

    console.log("=== IDENTIFIED RCM API ENDPOINTS ===");
    if (foundApis.size === 0) {
      console.log("No explicit API strings found in public chunks.");
    } else {
      foundApis.forEach(api => console.log("->", api));
    }

  } catch (err) {
    console.error("Error:", err.message);
  }
})();
