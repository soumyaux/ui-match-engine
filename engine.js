const { chromium } = require('playwright');
const fs = require('fs');

// 1. Create the folder IMMEDIATELY so GitHub always finds it
if (!fs.existsSync('playwright-report')) {
    fs.mkdirSync('playwright-report');
}

async function runAudit() {
  let browser;
  try {
    const targetUrl = process.env.TARGET_URL;
    console.log(`🌸 Starting Soothing Audit for: ${targetUrl}`);

    // Check if data actually arrived
    if (!process.env.TOKENS) throw new Error("No tokens received from GitHub environment!");
    const figmaTokens = JSON.parse(process.env.TOKENS);

    browser = await chromium.launch();
    const page = await browser.newPage();

    console.log("🌍 Navigating to site...");
    // Force wait until network is mostly idle to ensure CSS loads
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    console.log("📸 Snapping a screenshot of the live site...");
    await page.screenshot({ path: 'playwright-report/live-site-screenshot.png', fullPage: true });

    console.log("🔍 Running color match logic...");
    const report = await page.evaluate((design) => {
      const element = document.querySelector(`[data-testid="${design.name}"]`) || document.querySelector('button, h1, a');
      
      if (!element) return { match: false, reason: "Element not found on live site" };

      const liveStyle = window.getComputedStyle(element);
      const liveColor = liveStyle.backgroundColor; 
      
      // Safeguard against missing color data from Figma
      if (!design.color) return { match: false, reason: "Figma did not send color data" };

      const designColor = `rgb(${Math.round(design.color.r * 255)}, ${Math.round(design.color.g * 255)}, ${Math.round(design.color.b * 255)})`;

      return {
        match: liveColor === designColor,
        liveColor,
        designColor,
        score: liveColor === designColor ? 100 : 40
      };
    }, figmaTokens);

    console.log("📊 Audit Results:", report);
    
    // Save the success report!
    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(report, null, 2));
    
  } catch (error) {
    console.error("❌ Audit crashed:", error.message);
    // 🚑 SAVE THE ERROR TO THE FOLDER SO IT UPLOADS AS AN ARTIFACT
    fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
