const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('playwright-report')) {
  fs.mkdirSync('playwright-report');
}

async function runAudit() {
  let browser;
  try {
    const targetUrl = process.env.TARGET_URL;
    const threshold = Number(process.env.MATCH_THRESHOLD || 0);
    let figmaTokens = [];

    try {
      const parsed = JSON.parse(process.env.TOKENS || '[]');
      figmaTokens = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error('Failed to parse TOKENS. Using empty list.');
      figmaTokens = [];
    }

    // --- PHASE 0: Navigation & Reachability Check ---
    console.log(`🌸 Starting Deep Visual Scan for: ${targetUrl}`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    
    try {
      console.log(`🌍 Navigating to ${targetUrl}...`);
      const response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
      if (!response || !response.ok()) {
        const status = response ? response.status() : 'Unknown';
        console.error(`❌ HTTP Error ${status}: Target website returned an error or is unreachable.`);
        fs.writeFileSync('playwright-report/error-log.txt', `HTTP Error ${status}: Target website returned an error or is unreachable.`);
        process.exit(1);
      }
    } catch (navError) {
      console.error(`❌ Failed to reach ${targetUrl}. The URL might be invalid, or the site is down. Details: ${navError.message}`);
      fs.writeFileSync('playwright-report/error-log.txt', `Navigation failed: ${navError.message}`);
      process.exit(1);
    }

    // --- PHASE 1: 60% compatibility gate ---
    console.log('🔍 Running 60% Compatibility Check...');
    const matchResults = await page.evaluate((tokens) => {
      if (!tokens || tokens.length === 0) return { score: 0, total: 0, matched: 0 };
      let matchCount = 0;
      tokens.forEach((design) => {
        const escaped = CSS.escape(design.name || '');
        const exists = document.querySelector(
          `[data-testid="${design.name}"]` || ''
        ) || document.querySelector(`[name="${design.name}"]` || '') || document.querySelector(`.${escaped}`);
        if (exists) matchCount++;
      });
      return {
        score: (matchCount / tokens.length) * 100,
        total: tokens.length,
        matched: matchCount,
      };
    }, figmaTokens);

    if (matchResults.total === 0) {
      const msg = 'No tokens provided; skipping audit.';
      console.error(msg);
      fs.writeFileSync('playwright-report/error-log.txt', msg);
      process.exit(1);
    }

    if (matchResults.score < threshold) {
      const msg = `❌ Low match score: ${matchResults.score.toFixed(2)}% (matched ${matchResults.matched}/${matchResults.total}). Audit aborted.`;
      console.error(msg);
      fs.writeFileSync('playwright-report/error-log.txt', msg);
      await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
      process.exit(1);
    }

    // --- PHASE 2: Deep audit with highlighting ---
    console.log('🚀 Match confirmed! Starting deep-scan audit...');

    const report = await page.evaluate(({ tokens, matchResults, threshold }) => {
      const results = [
        {
          element: '__summary__',
          status: matchResults.score >= threshold ? 'PASS' : 'FAIL',
          details: [`Score: ${matchResults.score.toFixed(2)}%`, `Matched: ${matchResults.matched}/${matchResults.total}`],
        },
      ];
      tokens.forEach((design) => {
        const name = design.name || 'unknown';
        let elements = [];
        const selectors = [
          `[data-testid="${name}"]`,
          `[name="${name}"]`,
          `.${CSS.escape(name)}`,
          `.${(name || '').replace(/\s+/g, '-')}`,
          `.${(name || '').replace(/\s+/g, '_')}`,
        ];

        for (const sel of selectors) {
          try {
            const found = Array.from(document.querySelectorAll(sel));
            if (found.length > 0) {
              elements = found;
              break;
            }
          } catch (_) {
            continue;
          }
        }

        if (elements.length === 0) {
          elements = Array.from(document.querySelectorAll('button, a, h1, h2, p, .input'));
        }

        elements.forEach((el) => {
          const live = window.getComputedStyle(el);
          const errors = [];

          const liveRadius = parseFloat(live.borderRadius) || 0;
          const figmaRadius = design.borderRadius ?? design.cornerRadius ?? 0;
          if (figmaRadius !== 'Mixed' && Math.abs(liveRadius - figmaRadius) > 1) {
            errors.push(`Radius: Found ${liveRadius}px (Expected ${figmaRadius}px)`);
          }

          if (design.fontSize && design.fontSize !== 'Mixed') {
            const liveSize = parseFloat(live.fontSize);
            if (Math.abs(liveSize - design.fontSize) > 0.5) {
              errors.push(`Size: Found ${liveSize}px (Expected ${design.fontSize}px)`);
            }
          }

          if (design.fontFamily && live.fontFamily && !live.fontFamily.includes(design.fontFamily)) {
            errors.push(`Font: Found ${live.fontFamily} (Expected contains ${design.fontFamily})`);
          }

          if (design.color) {
            const liveColor = live.color;
            if (liveColor && !liveColor.toLowerCase().includes(String(design.color).toLowerCase())) {
              errors.push(`Color: Found ${liveColor} (Expected ${design.color})`);
            }
          }

          if (errors.length > 0) {
            el.style.outline = '3px dashed red';
            el.style.outlineOffset = '2px';
            el.style.backgroundColor = 'rgba(255, 0, 0, 0.05)';

            const badge = document.createElement('div');
            badge.innerHTML = `<b>${name}</b><br>${errors.join('<br>')}`;
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

          results.push({
            element: name,
            status: errors.length === 0 ? 'PASS' : 'FAIL',
            details: errors,
          });
        });

        if (design.borderRadius === 'Mixed' || design.cornerRadius === 'Mixed') {
          summary.details.push(`Mixed radius for ${name}`);
        }
      });

      return results;
    }, { tokens: figmaTokens, matchResults, threshold });

    await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(report, null, 2));
    console.log('✅ Audit completed successfully.');
  } catch (error) {
    console.error('❌ Audit failed:', error);
    fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
