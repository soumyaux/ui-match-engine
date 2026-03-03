const { chromium } = require('playwright');
const fs = require('fs'); // Added to help save the report files

async function runAudit() {
  const targetUrl = process.env.TARGET_URL;
  const figmaTokens = JSON.parse(process.env.TOKENS);

  console.log(`🌸 Starting Soothing Audit for: ${targetUrl}`);

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Create the report folder so GitHub Actions can find it later
  if (!fs.existsSync('playwright-report')){
      fs.mkdirSync('playwright-report');
  }

  try {
    await page.goto(targetUrl);
    
    // 📸 TAKE A VISUAL SCREENSHOT
    console.log("📸 Snapping a screenshot of the live site...");
    await page.screenshot({ path: 'playwright-report/live-site-screenshot.png', fullPage: true });

    // THE AUDIT LOGIC:
    const report = await page.evaluate((design) => {
      const element = document.querySelector(`[data-testid="${design.name}"]`) || document.querySelector('button, h1, a');
      
      if (!element) return { match: false, reason: "Element not found on live site" };

      const liveStyle = window.getComputedStyle(element);
      const liveColor = liveStyle.backgroundColor; 
      
      // Note: If your Figma plugin sends colors as 0-1 (e.g., r: 1, g: 0.5), 
      // you might need to multiply by 255 here to match the live site's rgb(255, 128, 0) format!
      const designColor = `rgb(${Math.round(design.color.r)}, ${Math.round(design.color.g)}, ${Math.round(design.color.b)})`;

      return {
        match: liveColor === designColor,
        liveColor,
        designColor,
        score: liveColor === designColor ? 100 : 40
      };
    }, figmaTokens); // 🚨 BUG FIXED: Changed 'tokens' to 'figmaTokens'

    console.log("📊 Audit Results:", report);
    
    // 💾 SAVE THE TEXT REPORT FOR THE ARTIFACT
    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(report, null, 2));
    
  } catch (error) {
    console.error("❌ Audit failed:", error);
  } finally {
    await browser.close();
  }
}

runAudit();
