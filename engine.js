const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('playwright-report')) {
    fs.mkdirSync('playwright-report');
}

async function runAudit() {
    let browser;
    try {
        const targetUrl = process.env.TARGET_URL;
        
        let figmaTokens = [];
        try {
            const parsed = JSON.parse(process.env.TOKENS);
            figmaTokens = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            console.error("Failed to parse TOKENS. Check your GitHub Action inputs.");
            figmaTokens = [];
        }

        console.log(`🌸 Starting Deep Visual Scan for: ${targetUrl}`);

        browser = await chromium.launch();
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(targetUrl, { waitUntil: 'networkidle' });

        // --- PHASE 1: COMPATIBILITY CHECK ---
console.log("🔍 Running 60% Compatibility Check...");
const matchResults = await page.evaluate((tokens) => {
    let matchCount = 0;
    tokens.forEach(design => {
        const escaped = CSS.escape(design.name);
        const exists = document.querySelector(`[data-testid="${design.name}"], [name="${design.name}"], .${escaped}`);
        if (exists) matchCount++;
    });
    return {
        score: (matchCount / tokens.length) * 100,
        total: tokens.length,
        matched: matchCount
    };
}, figmaTokens);

if (matchResults.score < 60) {
    console.error(`❌ ERROR: Match score ${matchResults.score.toFixed(2)}% is too low.`);
    // We intentionally throw an error here so the GitHub Action "fails"
    // This prevents the 'Upload to Supabase' step from starting
    process.exit(1); 
}
// At the top of your audit script
let tokens;
try {
    // If it's a string from the Worker, parse it. If it's already an object, use it.
    tokens = typeof figmaTokens === 'string' ? JSON.parse(figmaTokens) : figmaTokens;
} catch (e) {
    console.error("Token parsing failed:", e);
    tokens = [];
}

tokens.forEach(token => {
  // Use data attributes or sanitize names to avoid "Frame 1" selector errors
});
        // --- PHASE 2: DEEP AUDIT (Only runs if score >= 60%) ---
        console.log("🚀 Match confirmed! Starting deep-scan audit...");

        const report = await page.evaluate((tokens) => {
            let scanResults = [];

            tokens.forEach((design) => {
                let elements = [];
                const potentialSelectors = [
                    `[data-testid="${design.name}"]`,
                    `[name="${design.name}"]`,
                    `.${CSS.escape(design.name)}`,
                    `.${design.name.replace(/\s+/g, '-')}`,
                    `.${design.name.replace(/\s+/g, '_')}`
                ];

                for (const selector of potentialSelectors) {
                    try {
                        const found = Array.from(document.querySelectorAll(selector));
                        if (found.length > 0) {
                            elements = found;
                            break; 
                        }
                    } catch (e) { continue; } 
                }

                if (elements.length === 0) {
                    elements = Array.from(document.querySelectorAll('button, a, h1, h2, p, .input')); 
                }

                elements.forEach((el) => {
                    const live = window.getComputedStyle(el);
                    let errors = [];

                    // Border Radius Check
                    const liveRadius = parseFloat(live.borderRadius) || 0;
                    const figmaRadius = design.borderRadius || design.cornerRadius || 0;
                    if (figmaRadius !== "Mixed" && Math.abs(liveRadius - figmaRadius) > 1) {
                        errors.push(`Radius: Found ${liveRadius}px (Expected ${figmaRadius}px)`);
                    }

                    // Typography Check
                    if (design.fontSize && design.fontSize !== "Mixed") {
                        const liveSize = parseFloat(live.fontSize);
                        if (Math.abs(liveSize - design.fontSize) > 0.5) {
                            errors.push(`Size: Found ${liveSize}px (Expected ${design.fontSize}px)`);
                        }
                    }

                    // Visual Highlighting
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

        await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
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
