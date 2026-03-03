const { chromium } = require('playwright');
const fs = require('fs');

// 1. Create the report folder immediately
if (!fs.existsSync('playwright-report')){
    fs.mkdirSync('playwright-report');
}

async function runAudit() {
  let browser;
  try {
    const targetUrl = process.env.TARGET_URL;
    const figmaTokens = JSON.parse(process.env.TOKENS);

    console.log(`🌸 Starting Soothing Visual Audit for: ${targetUrl}`);

    browser = await chromium.launch();
    const page = await browser.newPage();

    console.log("🌍 Navigating to site...");
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    // --- 2. THE AUDIT & VISUAL MARKING LOGIC ---
    console.log("🔍 Comparing Figma tokens and drawing highlights...");
    const report = await page.evaluate((design) => {
      // Find the element on the live site
      const element = document.querySelector(`[data-testid="${design.name}"]`) || document.querySelector('button, h1, a');
      
      if (!element) return { match: false, reason: `Element '${design.name}' not found on live site` };

      // Get live styles
      const liveStyle = window.getComputedStyle(element);
      const liveColor = liveStyle.backgroundColor; 
      
      // Safeguard color data and perform Figma (0-1) to Web (0-255) conversion
      if (!design.color) return { match: false, reason: "Figma did not send color data" };
      const designColor = `rgb(${Math.round(design.color.r * 255)}, ${Math.round(design.color.g * 255)}, ${Math.round(design.color.b * 255)})`;

      const isMatch = liveColor === designColor;

      // ==========================================
      // 🚨 NEW: THE VISUAL MARKING 🚨
      // If it's NOT a match, draw a bright red box on the DOM
      // ==========================================
      if (!isMatch) {
        element.style.outline = '5px solid red'; // The Red Square
        element.style.outlineOffset = '2px';    // Space out the square
        element.style.boxShadow = '0 0 10px rgba(255, 0, 0, 0.7)'; // Add a glow so you can't miss it!
      } else {
        // Optional: Mark passing elements in green?
        // element.style.outline = '5px solid #10B981';
      }

      return {
        elementName: design.name,
        match: isMatch,
        liveColor,
        designColor,
        score: isMatch ? 100 : 40
      };
    }, figmaTokens);

    // --- 3. TAKE THE VISUAL SNAPSHOT ---
    // This happens AFTER we drew the red boxes in Step 2.
    console.log("📸 Snapping the highlighted screenshot...");
    await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });

    console.log("📊 Audit Results:", report);
    
    // Save the text report too
    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(report, null, 2));
    
  } catch (error) {
    console.error("❌ Audit failed:", error);
    fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
