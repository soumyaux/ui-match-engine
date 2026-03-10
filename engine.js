const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('playwright-report')) {
  fs.mkdirSync('playwright-report');
}

// ──────────────────────────────────────────────
// COLOR UTILITIES
// ──────────────────────────────────────────────
function parseColor(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  // hex
  if (s.startsWith('#')) return s;

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    const toHex = (v) => Number(v).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  return s;
}

function colorsMatch(figmaHex, liveRaw) {
  const a = parseColor(figmaHex);
  const b = parseColor(liveRaw);
  if (!a || !b) return true; // can't compare → no error
  return a === b;
}

// ──────────────────────────────────────────────
// MAIN AUDIT
// ──────────────────────────────────────────────
async function runAudit() {
  let browser;
  try {
    const targetUrl = process.env.TARGET_URL;
    const threshold = Number(process.env.MATCH_THRESHOLD || 0);
    let figmaTokens = [];

    // Read tokens from local file (downloaded from Supabase Storage)
    const tokensFile = process.env.TOKENS_FILE || 'tokens.json';
    try {
      if (fs.existsSync(tokensFile)) {
        const raw = fs.readFileSync(tokensFile, 'utf-8');
        const parsed = JSON.parse(raw);
        figmaTokens = Array.isArray(parsed) ? parsed : [parsed];
        console.log(`📦 Loaded ${figmaTokens.length} design tokens from ${tokensFile}`);
      } else {
        console.warn(`⚠️ Tokens file not found: ${tokensFile}`);
        figmaTokens = [];
      }
    } catch (e) {
      console.error('Failed to parse tokens file. Using empty list.');
      figmaTokens = [];
    }

    // ══════════════════════════════════════════
    // PHASE 0: Navigation & Reachability Check
    // ══════════════════════════════════════════
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

    // ══════════════════════════════════════════
    // PHASE 0.5: Wait for animations to settle
    // ══════════════════════════════════════════
    console.log('⏳ Waiting for animations to settle...');

    // 1. Initial wait for CSS/JS entry animations
    await page.waitForTimeout(3000);

    // 2. Scroll to bottom to trigger lazy-load and scroll-triggered animations
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const distance = 300;
        const delay = 100;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          if (window.scrollY + window.innerHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, delay);
      });
    });

    // 3. Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));

    // 4. Final settle wait
    await page.waitForTimeout(2000);

    console.log('✅ Page settled. Starting audit...');

    // ══════════════════════════════════════════
    // PHASE 0.75: Visual Similarity Pre-Check
    // ══════════════════════════════════════════
    const figmaImagePath = process.env.FIGMA_IMAGE;
    if (figmaImagePath && fs.existsSync(figmaImagePath)) {
      console.log('🖼️ Running visual similarity pre-check...');
      
      // Take a viewport-sized screenshot of the live page
      const liveScreenshotBuffer = await page.screenshot({ type: 'png' });
      fs.writeFileSync('playwright-report/live-screenshot.png', liveScreenshotBuffer);
      
      // Simple pixel-level comparison using raw PNG buffers
      // We compare file sizes and a rough histogram as a heuristic
      const figmaBuffer = fs.readFileSync(figmaImagePath);
      const figmaSize = figmaBuffer.length;
      const liveSize = liveScreenshotBuffer.length;
      
      // Quick heuristic: if file sizes differ by more than 5x, they're likely very different pages
      const sizeRatio = Math.min(figmaSize, liveSize) / Math.max(figmaSize, liveSize);
      console.log(`📊 Image size ratio: ${(sizeRatio * 100).toFixed(1)}% (Figma: ${figmaSize} bytes, Live: ${liveSize} bytes)`);
      
      // Compare byte-level similarity on a sample of the raw buffer
      // This is a rough but fast heuristic for "are these even the same page"
      const sampleSize = Math.min(figmaBuffer.length, liveScreenshotBuffer.length, 50000);
      let matchingBytes = 0;
      for (let i = 0; i < sampleSize; i++) {
        if (Math.abs(figmaBuffer[i] - liveScreenshotBuffer[i]) < 30) {
          matchingBytes++;
        }
      }
      const byteSimilarity = (matchingBytes / sampleSize) * 100;
      console.log(`📊 Byte-level similarity: ${byteSimilarity.toFixed(1)}%`);
      
      // If both heuristics indicate very low match, abort
      if (sizeRatio < 0.1 && byteSimilarity < 20) {
        const msg = `❌ Visual pre-check failed: The Figma design and live website don't appear to match.\nPlease verify you selected the correct Figma frame and entered the right URL.\n(Size ratio: ${(sizeRatio * 100).toFixed(1)}%, Byte similarity: ${byteSimilarity.toFixed(1)}%)`;
        console.error(msg);
        fs.writeFileSync('playwright-report/error-log.txt', msg);
        // Still save the screenshots for debugging
        await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
        process.exit(1);
      }
      
      console.log('✅ Visual pre-check passed. Designs appear related.');
    } else {
      console.log('⚠️ No Figma image provided, skipping visual pre-check.');
    }

    // ══════════════════════════════════════════
    // PHASE 1: 60% compatibility gate
    // ══════════════════════════════════════════
    console.log('🔍 Running Compatibility Check...');
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

    // ══════════════════════════════════════════
    // PHASE 2: Deep Comprehensive Audit
    // ══════════════════════════════════════════
    console.log('🚀 Match confirmed! Starting comprehensive deep-scan audit...');

    const report = await page.evaluate(({ tokens, matchResults, threshold }) => {
      // ── Color parse helper (browser-side) ──
      function parseColorBrowser(raw) {
        if (!raw) return null;
        const s = String(raw).trim().toLowerCase();
        if (s.startsWith('#')) return s;
        const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) {
          const hex = (v) => Number(v).toString(16).padStart(2, '0');
          return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
        }
        return s;
      }
      function colorsMatchBrowser(figmaHex, liveRaw) {
        const a = parseColorBrowser(figmaHex);
        const b = parseColorBrowser(liveRaw);
        if (!a || !b) return true;
        return a === b;
      }

      const results = [
        {
          element: '__summary__',
          status: matchResults.score >= threshold ? 'PASS' : 'FAIL',
          details: [`Score: ${matchResults.score.toFixed(2)}%`, `Matched: ${matchResults.matched}/${matchResults.total}`],
        },
      ];

      let processedCount = 0;
      const totalTokens = tokens.length;
      let issueNumber = 0;

      tokens.forEach((design) => {
        processedCount++;
        const name = design.name || 'unknown';
        let elements = [];
        const selectors = [
          `[data-testid="${name}"]`,
          `[name="${name}"]`,
          `.${CSS.escape(name)}`,
          `.${(name || '').replace(/\s+/g, '-')}`,
          `.${(name || '').replace(/\s+/g, '_')}`,
          `#${CSS.escape(name)}`,
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

        // If no element found by any selector, mark as NOT_FOUND and skip
        if (elements.length === 0) {
          results.push({
            element: name,
            status: 'NOT_FOUND',
            details: ['Element not found on page by name/class/id'],
          });
          return; // skip to next token
        }

        elements.forEach((el) => {
          const live = window.getComputedStyle(el);
          const errors = [];

          // ── 1. BORDER RADIUS ──
          const liveRadius = parseFloat(live.borderRadius) || 0;
          const figmaRadius = design.br ?? 0;
          if (figmaRadius !== 'Mixed' && figmaRadius > 0 && Math.abs(liveRadius - figmaRadius) > 1) {
            errors.push(`Border Radius: ${liveRadius}px → Expected ${figmaRadius}px`);
          }

          // ── 2. FONT SIZE ──
          if (design.fs && design.fs !== 'Mixed') {
            const liveSize = parseFloat(live.fontSize);
            if (Math.abs(liveSize - design.fs) > 0.5) {
              errors.push(`Font Size: ${liveSize}px → Expected ${design.fs}px`);
            }
          }

          // ── 3. FONT FAMILY ──
          if (design.ff && design.ff !== 'Mixed' && live.fontFamily) {
            if (!live.fontFamily.toLowerCase().includes(design.ff.toLowerCase())) {
              errors.push(`Font Family: ${live.fontFamily.split(',')[0].trim()} → Expected ${design.ff}`);
            }
          }

          // ── 4. FONT WEIGHT ──
          if (design.fw && design.fw !== 'Mixed') {
            const weightMap = { 'Thin': '100', 'ExtraLight': '200', 'Light': '300', 'Regular': '400', 'Medium': '500', 'SemiBold': '600', 'Bold': '700', 'ExtraBold': '800', 'Black': '900' };
            const expectedWeight = weightMap[design.fw] || design.fw;
            if (live.fontWeight !== expectedWeight && live.fontWeight !== String(expectedWeight)) {
              errors.push(`Font Weight: ${live.fontWeight} → Expected ${expectedWeight} (${design.fw})`);
            }
          }

          // ── 5. TEXT COLOR ──
          if (design.color) {
            if (!colorsMatchBrowser(design.color, live.color)) {
              errors.push(`Text Color: ${parseColorBrowser(live.color)} → Expected ${design.color.toLowerCase()}`);
            }
          }

          // ── 6. BACKGROUND COLOR ──
          if (design.bg && design.bg.length > 0) {
            const liveBg = parseColorBrowser(live.backgroundColor);
            if (liveBg && liveBg !== 'transparent' && !colorsMatchBrowser(design.bg[0], live.backgroundColor)) {
              errors.push(`Background: ${liveBg} → Expected ${design.bg[0].toLowerCase()}`);
            }
          }

          // ── 7. OPACITY ──
          if (design.op !== undefined && design.op < 1) {
            const liveOp = parseFloat(live.opacity);
            if (Math.abs(liveOp - design.op) > 0.05) {
              errors.push(`Opacity: ${liveOp} → Expected ${design.op}`);
            }
          }

          // ── 8. BORDER WIDTH (Stroke Weight) ──
          if (design.bw && design.bw > 0) {
            const liveBw = parseFloat(live.borderWidth) || parseFloat(live.borderTopWidth) || 0;
            if (Math.abs(liveBw - design.bw) > 0.5) {
              errors.push(`Border Width: ${liveBw}px → Expected ${design.bw}px`);
            }
          }

          // ── 9. BORDER COLOR ──
          if (design.bc) {
            const liveBc = parseColorBrowser(live.borderColor || live.borderTopColor);
            if (liveBc && !colorsMatchBrowser(design.bc, live.borderColor || live.borderTopColor)) {
              errors.push(`Border Color: ${liveBc} → Expected ${design.bc.toLowerCase()}`);
            }
          }

          // ── 10. PADDING ──
          if (design.pad && design.pad.some(v => v > 0)) {
            const livePad = [
              parseFloat(live.paddingTop) || 0,
              parseFloat(live.paddingRight) || 0,
              parseFloat(live.paddingBottom) || 0,
              parseFloat(live.paddingLeft) || 0,
            ];
            const padErrors = [];
            if (Math.abs(livePad[0] - design.pad[0]) > 2) padErrors.push(`top: ${livePad[0]}→${design.pad[0]}`);
            if (Math.abs(livePad[1] - design.pad[1]) > 2) padErrors.push(`right: ${livePad[1]}→${design.pad[1]}`);
            if (Math.abs(livePad[2] - design.pad[2]) > 2) padErrors.push(`bottom: ${livePad[2]}→${design.pad[2]}`);
            if (Math.abs(livePad[3] - design.pad[3]) > 2) padErrors.push(`left: ${livePad[3]}→${design.pad[3]}`);
            if (padErrors.length > 0) {
              errors.push(`Padding: ${padErrors.join(', ')}`);
            }
          }

          // ── 11. GAP (Item Spacing) ──
          if (design.gap && design.gap > 0) {
            let liveGap = 0;
            if (live.gap !== 'normal' && live.gap !== '') liveGap = parseFloat(live.gap);
            if (isNaN(liveGap)) liveGap = 0;
            if (Math.abs(liveGap - design.gap) > 2) {
              errors.push(`Gap: ${liveGap}px → Expected ${design.gap}px`);
            }
          }

          // ── 12. WIDTH ──
          if (design.w && design.w > 10) {
            const liveW = el.getBoundingClientRect().width;
            if (Math.abs(liveW - design.w) > 5) {
              errors.push(`Width: ${Math.round(liveW)}px → Expected ${design.w}px`);
            }
          }

          // ── 13. HEIGHT ──
          if (design.h && design.h > 10) {
            const liveH = el.getBoundingClientRect().height;
            if (Math.abs(liveH - design.h) > 5) {
              errors.push(`Height: ${Math.round(liveH)}px → Expected ${design.h}px`);
            }
          }

          // ── 14. LETTER SPACING ──
          if (design.ls !== undefined) {
            let liveLS = 0;
            if (live.letterSpacing !== 'normal' && live.letterSpacing !== '') liveLS = parseFloat(live.letterSpacing);
            if (isNaN(liveLS)) liveLS = 0;
            if (Math.abs(liveLS - design.ls) > 0.5) {
              errors.push(`Letter Spacing: ${liveLS}px → Expected ${design.ls}px`);
            }
          }

          // ── 15. LINE HEIGHT ──
          if (design.lh !== undefined) {
            let liveLH = parseFloat(live.lineHeight);
            if (isNaN(liveLH) || live.lineHeight === 'normal') {
              liveLH = parseFloat(live.fontSize) * 1.2;
            }
            if (liveLH > 0 && Math.abs(liveLH - design.lh) > 2) {
              errors.push(`Line Height: ${Math.round(liveLH)}px → Expected ${design.lh}px`);
            }
          }

          // ── 16. TEXT ALIGN ──
          if (design.ta) {
            const expected = design.ta === 'justified' ? 'justify' : design.ta;
            if (live.textAlign !== expected) {
              errors.push(`Text Align: ${live.textAlign} → Expected ${expected}`);
            }
          }

          // ── 17. TEXT DECORATION ──
          if (design.td) {
            if (!live.textDecoration.toLowerCase().includes(design.td)) {
              errors.push(`Text Decoration: ${live.textDecoration} → Expected ${design.td}`);
            }
          }

          // ── 18. TEXT TRANSFORM ──
          if (design.tt) {
            if (live.textTransform !== design.tt) {
              errors.push(`Text Transform: ${live.textTransform} → Expected ${design.tt}`);
            }
          }

          // ── HIGHLIGHT MISMATCHES ON PAGE ──
          if (errors.length > 0) {
            issueNumber++;
            const rect = el.getBoundingClientRect();

            el.style.outline = '2px solid #FF3B30';
            el.style.outlineOffset = '3px';

            const marker = document.createElement('div');
            marker.textContent = String(issueNumber);
            marker.style.cssText = `
              position: absolute;
              top: ${window.scrollY + rect.top - 14}px;
              left: ${window.scrollX + rect.left - 14}px;
              width: 28px; height: 28px;
              background: #FF3B30; color: white;
              border-radius: 50%;
              font-family: -apple-system, sans-serif;
              font-size: 13px; font-weight: 700;
              display: flex; align-items: center; justify-content: center;
              z-index: 10000; pointer-events: none;
              box-shadow: 0 2px 8px rgba(0,0,0,0.35);
              border: 2.5px solid white;
            `;
            document.body.appendChild(marker);
          }

          results.push({
            element: name,
            status: errors.length === 0 ? 'PASS' : 'FAIL',
            details: errors,
          });
        });
      });

      return results;
    }, { tokens: figmaTokens, matchResults, threshold });

    // ══════════════════════════════════════════
    // PHASE 3: Screenshot & HTML Report
    // ══════════════════════════════════════════
    console.log('📸 Taking annotated screenshot...');
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    fs.writeFileSync('playwright-report/live-screenshot.png', screenshotBuffer);

    const failedIssues = report.filter(r => r.status === 'FAIL' && r.element !== '__summary__');
    const passCount = report.filter(r => r.status === 'PASS' && r.element !== '__summary__').length;
    const notFoundCount = report.filter(r => r.status === 'NOT_FOUND').length;
    const screenshotBase64 = screenshotBuffer.toString('base64');
    const auditDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const frameName = (figmaTokens[0] && figmaTokens[0]._frameName) || 'Selected Frame';

    const issueRows = failedIssues.map((issue, i) => `
      <div style="display:flex;gap:14px;padding:16px;margin:0 0 10px;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,0.06);border-left:4px solid #FF3B30;">
        <div style="min-width:32px;height:32px;background:#FF3B30;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">${i + 1}</div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:15px;color:#0f1b35;margin-bottom:3px;">${issue.element}</div>
          <div style="color:#64748b;font-size:13px;line-height:1.6;">${issue.details.join(' &middot; ')}</div>
        </div>
      </div>
    `).join('');

    const reportHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;">
  <div style="background:linear-gradient(135deg,#0f5ec4 0%,#3da5ff 100%);padding:40px 48px;color:#fff;">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
      <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px;">UI Match</div>
      <div style="font-size:13px;opacity:0.7;border-left:2px solid rgba(255,255,255,0.3);padding-left:16px;">Visual Audit Report</div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px 32px;font-size:13px;opacity:0.9;">
      <div>🎨 <strong>Figma Frame:</strong> ${frameName}</div>
      <div>🌍 <strong>Website:</strong> ${targetUrl}</div>
      <div>📅 <strong>Date:</strong> ${auditDate}</div>
    </div>
    <div style="display:flex;gap:16px;margin-top:24px;">
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${matchResults.score.toFixed(0)}%</div>
        <div style="font-size:11px;opacity:0.8;">Match Score</div>
      </div>
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${failedIssues.length}</div>
        <div style="font-size:11px;opacity:0.8;">Issues Found</div>
      </div>
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${passCount}</div>
        <div style="font-size:11px;opacity:0.8;">Passed</div>
      </div>
    </div>
  </div>
  <div style="padding:32px 48px;">
    <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">📸 Screenshot with Issue Markers</h2>
    <img src="data:image/png;base64,${screenshotBase64}" style="width:100%;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1);border:1px solid #e2e8f0;" />
  </div>
  <div style="padding:0 48px 48px;">
    <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">🔍 Issue Details</h2>
    ${failedIssues.length > 0 ? issueRows : '<div style="padding:24px;background:#f0fdf4;border-radius:12px;color:#16a34a;font-weight:600;text-align:center;">✅ No design issues found! Perfect match.</div>'}
  </div>
</body></html>`;

    console.log('🖨️ Rendering HTML report...');
    const reportPage = await browser.newPage();
    await reportPage.setViewportSize({ width: 1200, height: 800 });
    await reportPage.setContent(reportHtml, { waitUntil: 'load' });
    await reportPage.waitForTimeout(500);
    await reportPage.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
    await reportPage.close();
    console.log('📸 HTML report saved as visual-audit-diff.png');

    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(report, null, 2));
    console.log(`✅ Audit completed. ${passCount} passed, ${failedIssues.length} issues, ${notFoundCount} not found — across ${figmaTokens.length} tokens.`);
  } catch (error) {
    console.error('❌ Audit failed:', error);
    fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
