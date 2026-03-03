const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('playwright-report')){
    fs.mkdirSync('playwright-report');
}

async function runAudit() {
  let browser;
  try {
    const targetUrl = process.env.TARGET_URL;
    const figmaTokens = JSON.parse(process.env.TOKENS);

    console.log(`🌸 Starting Deep Visual Scan for: ${targetUrl}`);

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    console.log("🔍 Scanning ALL elements on the page...");
    
    const report = await page.evaluate((design) => {
      // 1. USE QUERY SELECTOR ALL: Find EVERY matching element on the page
      let elements = Array.from(document.querySelectorAll(`[data-testid="${design.name}"]`));
      
      // Fallback: If no test-id is found, grab all buttons/links to check them
      if (elements.length === 0) {
        elements = Array.from(document.querySelectorAll('button, .btn, a')); 
      }

      let scanResults = [];
      let expectedBg = null;

      // Format the expected Figma color
      if (design.color) {
        expectedBg = `rgb(${Math.round(design.color.r * 255)}, ${Math.round(design.color.g * 255)}, ${Math.round(design.color.b * 255)})`;
      }

      // 2. LOOP THROUGH EVERY ELEMENT
      elements.forEach((el, index) => {
        const liveStyle = window.getComputedStyle(el);
        let errors = [];

        // Check Background Color (ignoring transparent backgrounds)
        if (expectedBg && liveStyle.backgroundColor !== expectedBg && liveStyle.backgroundColor !== 'rgba(0, 0, 0, 0)') {
           errors.push(`Found: ${liveStyle.backgroundColor}`);
        }

        // Check Font Size (If your Figma plugin sends it!)
        if (design.fontSize && liveStyle.fontSize !== `${design.fontSize}px`) {
           errors.push(`Font: ${liveStyle.fontSize}`);
        }

        // 3. IF THERE ARE ERRORS, DRAW THE RED BOX AND LABEL
        if (errors.length > 0) {
          // Draw the Box
          el.style.outline = '4px solid red';
          el.style.outlineOffset = '2px';
          el.style.boxShadow = '0 0 15px rgba(255,0,0,0.8)';

          // Create the floating error label
          const label = document.createElement('div');
          label.innerText = `❌ ${errors.join(' | ')}`;
          label.style.cssText = 'position: absolute; background: red; color: white; font-family: monospace; font-size: 10px; padding: 4px; border-radius: 4px; z-index: 99999; margin-top: -25px; pointer-events: none;';
          
          if (el.parentNode) {
            el.parentNode.insertBefore(label, el);
          }
        }

        scanResults.push({ id: index, match: errors.length === 0, errors });
      });

      return scanResults;
    }, figmaTokens);

    console.log("📸 Snapping the Deep Scan screenshot...");
    await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });

    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(report, null, 2));
    
  } catch (error) {
    console.error("❌ Audit failed:", error);
    fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
