const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('playwright-report')) {
    fs.mkdirSync('playwright-report');
}

async function runAudit() {
  let browser;
  try {
    const targetUrl = process.env.TARGET_URL;
    
    // 🚨 THE FIX: Ensure tokens is parsed as an Array
    let figmaTokens = [];
    try {
        const parsed = JSON.parse(process.env.TOKENS);
        // If it's a single layer object, wrap it in []. If it's already a list, use it.
        figmaTokens = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
        console.error("Failed to parse TOKENS. Check your GitHub Action inputs.");
        figmaTokens = [];
    }

    console.log(`🌸 Starting Deep Visual Scan for: ${targetUrl}`);

        browser = await chromium.launch();
        const page = await browser.newPage();
        
        // Set a standard viewport to match your design expectations
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(targetUrl, { waitUntil: 'networkidle' });

        console.log("🔍 Comparing Figma Tokens to Live Site...");

        const report = await page.evaluate((tokens) => {
            let scanResults = [];

            // Helper to handle multiple selector attempts per token
            tokens.forEach((design) => {
                let elements = [];
                
                // 1. Build a list of potential CSS selectors based on the layer name
                const potentialSelectors = [
                    `[data-testid="${design.name}"]`,
                    `[name="${design.name}"]`,
                    `.${CSS.escape(design.name)}`, // Handles spaces like "Frame 1"
                    `.${design.name.replace(/\s+/g, '-')}`, // Tries "frame-1"
                    `.${design.name.replace(/\s+/g, '_')}`  // Tries "frame_1"
                ];

                // 2. Try each selector one-by-one inside a try/catch to prevent crashes
                for (const selector of potentialSelectors) {
                    try {
                        const found = Array.from(document.querySelectorAll(selector));
                        if (found.length > 0) {
                            elements = found;
                            break; 
                        }
                    } catch (e) { continue; } 
                }

                // 3. Fallback: If no match is found, check generic UI elements
                if (elements.length === 0) {
                    elements = Array.from(document.querySelectorAll('button, a, h1, h2, p, .input')); 
                }

                // 4. Compare style properties for every found element
                elements.forEach((el, index) => {
                    const live = window.getComputedStyle(el);
                    let errors = [];

                    // --- BORDER RADIUS CHECK ---
                    const liveRadius = parseFloat(live.borderRadius) || 0;
                    const figmaRadius = design.borderRadius || design.cornerRadius || 0;
                    if (figmaRadius !== "Mixed" && Math.abs(liveRadius - figmaRadius) > 1) {
                        errors.push(`Radius: Found ${liveRadius}px (Expected ${figmaRadius}px)`);
                    }

                    // --- TYPOGRAPHY CHECK ---
                    if (design.fontSize && design.fontSize !== "Mixed") {
                        const liveSize = parseFloat(live.fontSize);
                        if (Math.abs(liveSize - design.fontSize) > 0.5) {
                            errors.push(`Size: Found ${liveSize}px (Expected ${design.fontSize}px)`);
                        }
                    }

                    // --- VISUAL HIGHLIGHTING (Red Box & Badge) ---
                    if (errors.length > 0) {
                        el.style.outline = '3px dashed red';
                        el.style.outlineOffset = '2px';
                        el.style.backgroundColor = 'rgba(255, 0, 0, 0.05)';

                        const badge = document.createElement('div');
                        badge.innerHTML = `<b>${design.name}</b><br>${errors.join('<br>')}`;
                        badge.style.cssText = `
                            position: absolute; background: #ff0000; color: white;
                            font-family: sans-serif; font-size: 10px; padding: 4px 8px;
                            border-radius: 4px; z-index: 10000; pointer-events: none;
                            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                        `;
                        const rect = el.getBoundingClientRect();
                        badge.style.top = `${window.scrollY + rect.top - 30}px`;
                        badge.style.left = `${window.scrollX + rect.left}px`;
                        document.body.appendChild(badge);
                    }

                    scanResults.push({ 
                        element: design.name, 
                        status: errors.length === 0 ? 'PASS' : 'FAIL', 
                        details: errors 
                    });
                });
            });

            return scanResults;
        }, figmaTokens);

        console.log("📸 Saving visual audit screenshot...");
        await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });

        // Save report data for the Figma plugin to read
        fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(report, null, 2));
        console.log("✅ Audit completed successfully.");

    } catch (error) {
        console.error("❌ Audit failed:", error);
        fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
    } finally {
        if (browser) await browser.close();
    }
}

runAudit();
