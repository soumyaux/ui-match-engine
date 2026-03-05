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
      // 1. Better Selector: Look for data-testid, name, or common components
      let elements = Array.from(document.querySelectorAll(`[data-testid="${design.name}"], [name="${design.name}"], .${design.name}`));
      
      if (elements.length === 0) {
        elements = Array.from(document.querySelectorAll('button, a, h1, h2, p, .input')); 
      }

      let scanResults = [];

      // 2. Loop and Compare EVERY Detail
      elements.forEach((el, index) => {
        const live = window.getComputedStyle(el);
        let errors = [];

        // --- BORDER RADIUS CHECK ---
        const liveRadius = parseFloat(live.borderRadius) || 0;
        const figmaRadius = design.cornerRadius || 0;
        if (Math.abs(liveRadius - figmaRadius) > 1) { // 1px tolerance
          errors.push(`Radius: Found ${liveRadius}px (Expected ${figmaRadius}px)`);
        }

        // --- TYPOGRAPHY CHECK ---
        if (design.fontSize) {
          const liveSize = parseFloat(live.fontSize);
          if (Math.abs(liveSize - design.fontSize) > 0.5) {
            errors.push(`Size: Found ${liveSize}px (Expected ${design.fontSize}px)`);
          }
        }

        // --- FONT WEIGHT/STYLE CHECK ---
        if (design.fontName) {
           const liveFont = live.fontFamily.toLowerCase();
           if (!liveFont.includes(design.fontName.toLowerCase())) {
             errors.push(`Font: ${live.fontFamily.split(',')[0]}`);
           }
        }

        // --- COLOR CHECK (Figma RGB to Browser RGB) ---
        if (design.fills && design.fills.length > 0) {
          // You'll need to pass the hex/rgb string from Figma to make this simpler
          const expectedColor = design.fills[0]; // Assuming you send a string like "rgb(x,y,z)"
          if (live.color !== expectedColor && live.backgroundColor !== expectedColor) {
             // Optional: Add color mismatch logic here
          }
        }

        // 3. VISUAL HIGHLIGHTING
        if (errors.length > 0) {
          // Highlight the element
          el.style.outline = '3px dashed red';
          el.style.outlineOffset = '2px';
          el.style.backgroundColor = 'rgba(255, 0, 0, 0.05)';

          // Create floating error tooltip
          const badge = document.createElement('div');
          badge.innerHTML = `<b>${design.name || 'Element'}</b><br>${errors.join('<br>')}`;
          badge.style.cssText = `
            position: absolute; 
            background: #ff0000; 
            color: white; 
            font-family: 'Inter', sans-serif; 
            font-size: 11px; 
            padding: 6px 10px; 
            border-radius: 4px; 
            z-index: 10000; 
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            pointer-events: none;
            white-space: nowrap;
          `;
          
          // Position the badge above the element
          const rect = el.getBoundingClientRect();
          badge.style.top = `${window.scrollY + rect.top - 35}px`;
          badge.style.left = `${window.scrollX + rect.left}px`;
          document.body.appendChild(badge);
        }

        scanResults.push({ 
          element: design.name, 
          status: errors.length === 0 ? 'PASS' : 'FAIL', 
          details: errors 
        });
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
