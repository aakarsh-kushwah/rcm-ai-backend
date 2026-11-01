const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  console.log("Launching browser to capture login network API...");
  const browser = await puppeteer.launch({ 
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Intercept all network requests
  page.on('request', req => {
    const url = req.url();
    const method = req.method();
    if (method === 'POST' || url.includes('login') || url.includes('auth') || url.includes('token') || url.includes('api')) {
      console.log(`\n>>> [REQUEST] ${method} ${url}`);
      const postData = req.postData();
      if (postData) {
        console.log(`>>> [PAYLOAD]:`, postData);
      }
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('login') || url.includes('auth') || url.includes('token') || url.includes('api')) {
      console.log(`<<< [RESPONSE] ${res.status()} ${url}`);
    }
  });

  try {
    await page.goto('https://www.rcmworld.com', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log("\n[ACTION REQUIRED] Browser open ho gaya hai. Browser me Login par click karein aur credentials submit karein...");
    console.log("Terminal par exact API URL aur Payload capture ho jayega. (Script will stay open for 60 seconds)\n");
    await new Promise(r => setTimeout(r, 60000));
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await browser.close();
  }
})();
