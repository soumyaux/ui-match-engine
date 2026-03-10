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
  if (s.startsWith('#')) return s;
  const rgbMatch = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    const toHex = (v) => Number(v).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  return s;
}

// ──────────────────────────────────────────────
// MAIN AUDIT
// ──────────────────────────────────────────────
async function runAudit() {
  let browser;
  try {
    const targetUrl = process.env.TARGET_URL;
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

    // Extract frame metadata from tokens
    const frameName = (figmaTokens[0] && figmaTokens[0]._frameName) || 'Selected Frame';
    const frameWidth = (figmaTokens[0] && figmaTokens[0]._frameWidth) || 1440;
    const frameHeight = (figmaTokens[0] && figmaTokens[0]._frameHeight) || 900;

    // ══════════════════════════════════════════
    // PHASE 0: Navigation
    // ══════════════════════════════════════════
    console.log(`🌸 Starting Structural Spatial Audit for: ${targetUrl}`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Force viewport to match Figma frame width exactly
    await page.setViewportSize({ width: frameWidth, height: frameHeight });
    console.log(`📐 Viewport set to ${frameWidth}×${frameHeight} (matching Figma frame)`);

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
      console.error(`❌ Failed to reach ${targetUrl}. Details: ${navError.message}`);
      fs.writeFileSync('playwright-report/error-log.txt', `Navigation failed: ${navError.message}`);
      process.exit(1);
    }

    // ══════════════════════════════════════════
    // PHASE 0.5: Wait for page to settle
    // ══════════════════════════════════════════
    console.log('⏳ Waiting for animations to settle...');

    // Hide scrollbar to prevent layout shift
    await page.addStyleTag({ content: '::-webkit-scrollbar { display: none !important; } * { scrollbar-width: none !important; }' });

    await page.waitForTimeout(3000);

    // Scroll to bottom to trigger lazy-loaded content, then back up
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
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);
    console.log('✅ Page settled. Starting structural audit...');

    // ══════════════════════════════════════════
    // PHASE 1: Overall Visual Compatibility Gate
    // ══════════════════════════════════════════
    const figmaImagePath = process.env.FIGMA_IMAGE;
    let visuallyCompatible = true;

    if (figmaImagePath && fs.existsSync(figmaImagePath)) {
      console.log('🖼️ Running visual compatibility check...');
      const liveScreenshotBuffer = await page.screenshot({ type: 'png' });
      const figmaBuffer = fs.readFileSync(figmaImagePath);

      // Simple heuristic: compare byte-level samples
      const sampleSize = Math.min(figmaBuffer.length, liveScreenshotBuffer.length, 50000);
      let matchingBytes = 0;
      for (let i = 0; i < sampleSize; i++) {
        if (Math.abs(figmaBuffer[i] - liveScreenshotBuffer[i]) < 30) matchingBytes++;
      }
      const byteSimilarity = (matchingBytes / sampleSize) * 100;
      console.log(`📊 Visual similarity: ${byteSimilarity.toFixed(1)}%`);

      if (byteSimilarity < 15) {
        const msg = `❌ These screens appear to be completely different. Please verify the URL matches your Figma frame. (Similarity: ${byteSimilarity.toFixed(1)}%)`;
        console.error(msg);
        fs.writeFileSync('playwright-report/error-log.txt', msg);
        await page.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
        process.exit(1);
      }
      console.log('✅ Visual compatibility confirmed. Screens are related.');
    } else {
      console.log('⚠️ No Figma image provided, skipping visual compatibility check.');
    }

    // ══════════════════════════════════════════
    // PHASE 2: Structural Spatial Analysis
    // ══════════════════════════════════════════
    console.log('🚀 Starting Structural Spatial Analysis...');

    // Filter tokens that have meaningful spatial data
    const spatialTokens = figmaTokens.filter(t =>
      t.x !== undefined && t.y !== undefined && t.w > 2 && t.h > 2 &&
      !t.name?.startsWith('_') // skip metadata keys
    );

    console.log(`🎯 Analyzing ${spatialTokens.length} spatial tokens...`);

    const report = await page.evaluate((tokens) => {
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

      const results = [];
      let issueNumber = 0;

      tokens.forEach((design) => {
        const name = design.name || 'unknown';
        const cx = design.x + Math.round(design.w / 2);
        const cy = design.y + Math.round(design.h / 2);

        // ── SPATIAL MATCHING: find DOM element at this (x, y) position ──
        const el = document.elementFromPoint(cx, cy);

        if (!el || el === document.body || el === document.documentElement) {
          // Check if something should be here based on token size
          if (design.w > 20 && design.h > 20) {
            issueNumber++;
            // Draw a bounding box at the missing location
            const marker = document.createElement('div');
            marker.style.cssText = `
              position: absolute; z-index: 10000; pointer-events: none;
              top: ${design.y}px; left: ${design.x}px;
              width: ${design.w}px; height: ${design.h}px;
              border: 2px dashed #FF3B30;
              background: rgba(255, 59, 48, 0.08);
            `;
            document.body.appendChild(marker);

            const badge = document.createElement('div');
            badge.textContent = String(issueNumber);
            badge.style.cssText = `
              position: absolute; z-index: 10001; pointer-events: none;
              top: ${design.y - 14}px; left: ${design.x - 14}px;
              width: 28px; height: 28px;
              background: #FF3B30; color: white; border-radius: 50%;
              font-family: -apple-system, sans-serif;
              font-size: 13px; font-weight: 700;
              display: flex; align-items: center; justify-content: center;
              box-shadow: 0 2px 8px rgba(0,0,0,0.35);
              border: 2.5px solid white;
            `;
            document.body.appendChild(badge);

            results.push({
              element: name,
              status: 'MISSING',
              issueNum: issueNumber,
              region: `(${design.x}, ${design.y})`,
              details: [`Missing Component: No element found at position (${design.x}, ${design.y}). Expected a ${design.w}×${design.h}px element.`],
            });
          }
          return;
        }

        // ── ELEMENT FOUND: compare design system properties ──
        const live = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const errors = [];

        // ── LAYOUT SHIFT CHECK ──
        if (design.w > 20) {
          const diff = Math.abs(rect.width - design.w);
          if (diff > 10) {
            errors.push(`Width: ${Math.round(rect.width)}px (Expected ${design.w}px)`);
          }
        }
        if (design.h > 20) {
          const diff = Math.abs(rect.height - design.h);
          if (diff > 10) {
            errors.push(`Height: ${Math.round(rect.height)}px (Expected ${design.h}px)`);
          }
        }

        // ── BORDER RADIUS ──
        if (design.br !== undefined && design.br !== 'Mixed' && design.br > 0) {
          const liveRadius = parseFloat(live.borderRadius) || 0;
          if (Math.abs(liveRadius - design.br) > 1) {
            errors.push(`Border Radius: ${liveRadius}px (Expected ${design.br}px)`);
          }
        }

        // ── FONT SIZE ──
        if (design.fs && design.fs !== 'Mixed') {
          const liveSize = parseFloat(live.fontSize);
          if (Math.abs(liveSize - design.fs) > 0.5) {
            errors.push(`Font Size: ${liveSize}px (Expected ${design.fs}px)`);
          }
        }

        // ── FONT FAMILY ──
        if (design.ff && design.ff !== 'Mixed' && live.fontFamily) {
          if (!live.fontFamily.toLowerCase().includes(design.ff.toLowerCase())) {
            errors.push(`Font Family: ${live.fontFamily.split(',')[0].trim()} (Expected ${design.ff})`);
          }
        }

        // ── FONT WEIGHT ──
        if (design.fw && design.fw !== 'Mixed') {
          const weightMap = { 'Thin': '100', 'ExtraLight': '200', 'Light': '300', 'Regular': '400', 'Medium': '500', 'SemiBold': '600', 'Bold': '700', 'ExtraBold': '800', 'Black': '900' };
          const expectedWeight = weightMap[design.fw] || design.fw;
          if (live.fontWeight !== expectedWeight && live.fontWeight !== String(expectedWeight)) {
            errors.push(`Font Weight: ${live.fontWeight} (Expected ${expectedWeight} / ${design.fw})`);
          }
        }

        // ── TEXT COLOR ──
        if (design.color) {
          if (!colorsMatchBrowser(design.color, live.color)) {
            errors.push(`Text Color: ${parseColorBrowser(live.color)} (Expected ${design.color.toLowerCase()})`);
          }
        }

        // ── BACKGROUND COLOR ──
        if (design.bg && design.bg.length > 0) {
          const liveBg = parseColorBrowser(live.backgroundColor);
          if (liveBg && liveBg !== 'transparent' && liveBg !== 'rgba(0, 0, 0, 0)' && !colorsMatchBrowser(design.bg[0], live.backgroundColor)) {
            errors.push(`Background: ${liveBg} (Expected ${design.bg[0].toLowerCase()})`);
          }
        }

        // ── OPACITY ──
        if (design.op !== undefined && design.op < 1) {
          const liveOp = parseFloat(live.opacity);
          if (Math.abs(liveOp - design.op) > 0.05) {
            errors.push(`Opacity: ${liveOp} (Expected ${design.op})`);
          }
        }

        // ── BORDER WIDTH ──
        if (design.bw && design.bw > 0) {
          const liveBw = parseFloat(live.borderWidth) || parseFloat(live.borderTopWidth) || 0;
          if (Math.abs(liveBw - design.bw) > 0.5) {
            errors.push(`Border Width: ${liveBw}px (Expected ${design.bw}px)`);
          }
        }

        // ── BORDER COLOR ──
        if (design.bc) {
          const liveBc = parseColorBrowser(live.borderColor || live.borderTopColor);
          if (liveBc && !colorsMatchBrowser(design.bc, live.borderColor || live.borderTopColor)) {
            errors.push(`Border Color: ${liveBc} (Expected ${design.bc.toLowerCase()})`);
          }
        }

        // ── PADDING ──
        if (design.pad && design.pad.some(v => v > 0)) {
          const livePad = [
            parseFloat(live.paddingTop) || 0, parseFloat(live.paddingRight) || 0,
            parseFloat(live.paddingBottom) || 0, parseFloat(live.paddingLeft) || 0,
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

        // ── GAP ──
        if (design.gap && design.gap > 0) {
          let liveGap = 0;
          if (live.gap !== 'normal' && live.gap !== '') liveGap = parseFloat(live.gap);
          if (isNaN(liveGap)) liveGap = 0;
          if (Math.abs(liveGap - design.gap) > 2) {
            errors.push(`Gap: ${liveGap}px (Expected ${design.gap}px)`);
          }
        }

        // ── LETTER SPACING ──
        if (design.ls !== undefined) {
          let liveLS = 0;
          if (live.letterSpacing !== 'normal' && live.letterSpacing !== '') liveLS = parseFloat(live.letterSpacing);
          if (isNaN(liveLS)) liveLS = 0;
          if (Math.abs(liveLS - design.ls) > 0.5) {
            errors.push(`Letter Spacing: ${liveLS}px (Expected ${design.ls}px)`);
          }
        }

        // ── LINE HEIGHT ──
        if (design.lh !== undefined) {
          let liveLH = parseFloat(live.lineHeight);
          if (isNaN(liveLH) || live.lineHeight === 'normal') {
            liveLH = parseFloat(live.fontSize) * 1.2;
          }
          if (liveLH > 0 && Math.abs(liveLH - design.lh) > 2) {
            errors.push(`Line Height: ${Math.round(liveLH)}px (Expected ${design.lh}px)`);
          }
        }

        // ── TEXT ALIGN ──
        if (design.ta) {
          const expected = design.ta === 'justified' ? 'justify' : design.ta;
          if (live.textAlign !== expected) {
            errors.push(`Text Align: ${live.textAlign} (Expected ${expected})`);
          }
        }

        // ── TEXT DECORATION ──
        if (design.td) {
          if (!live.textDecoration.toLowerCase().includes(design.td)) {
            errors.push(`Text Decoration: ${live.textDecoration} (Expected ${design.td})`);
          }
        }

        // ── TEXT TRANSFORM ──
        if (design.tt) {
          if (live.textTransform !== design.tt) {
            errors.push(`Text Transform: ${live.textTransform} (Expected ${design.tt})`);
          }
        }

        // ── DRAW MARKERS IF ERRORS FOUND ──
        if (errors.length > 0) {
          issueNumber++;

          el.style.outline = '2px solid #FF3B30';
          el.style.outlineOffset = '3px';

          const marker = document.createElement('div');
          marker.textContent = String(issueNumber);
          marker.style.cssText = `
            position: absolute; z-index: 10001; pointer-events: none;
            top: ${window.scrollY + rect.top - 14}px;
            left: ${window.scrollX + rect.left - 14}px;
            width: 28px; height: 28px;
            background: #FF3B30; color: white; border-radius: 50%;
            font-family: -apple-system, sans-serif;
            font-size: 13px; font-weight: 700;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            border: 2.5px solid white;
          `;
          document.body.appendChild(marker);

          results.push({
            element: name,
            status: 'FAIL',
            issueNum: issueNumber,
            region: `(${Math.round(rect.left)}, ${Math.round(rect.top)})`,
            details: errors,
          });
        } else {
          results.push({
            element: name,
            status: 'PASS',
            details: [],
          });
        }
      });

      return results;
    }, spatialTokens);

    // ══════════════════════════════════════════
    // PHASE 3: Screenshot & HTML Report
    // ══════════════════════════════════════════
    console.log('📸 Taking annotated screenshot...');
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    fs.writeFileSync('playwright-report/live-screenshot.png', screenshotBuffer);

    const failedIssues = report.filter(r => r.status === 'FAIL' || r.status === 'MISSING');
    const passCount = report.filter(r => r.status === 'PASS').length;
    const missingCount = report.filter(r => r.status === 'MISSING').length;
    const totalChecked = report.length;
    const matchScore = totalChecked > 0 ? Math.round((passCount / totalChecked) * 100) : 0;

    const screenshotBase64 = screenshotBuffer.toString('base64');
    const auditDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const issueRows = failedIssues.map((issue) => {
      const icon = issue.status === 'MISSING' ? '🔴' : '🟠';
      const label = issue.status === 'MISSING' ? 'Missing Component' : 'Design Mismatch';
      return `
      <div style="display:flex;gap:14px;padding:16px;margin:0 0 10px;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,0.06);border-left:4px solid ${issue.status === 'MISSING' ? '#FF3B30' : '#FF9500'};">
        <div style="min-width:32px;height:32px;background:${issue.status === 'MISSING' ? '#FF3B30' : '#FF9500'};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">${issue.issueNum}</div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:15px;color:#0f1b35;margin-bottom:3px;">${icon} ${label}: ${issue.element}</div>
          <div style="color:#64748b;font-size:13px;line-height:1.6;">${issue.details.join(' &middot; ')}</div>
          <div style="color:#94a3b8;font-size:11px;margin-top:4px;">📍 Region: ${issue.region}</div>
        </div>
      </div>
    `}).join('');

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
      <div>📐 <strong>Viewport:</strong> ${frameWidth}×${frameHeight}px</div>
    </div>
    <div style="display:flex;gap:16px;margin-top:24px;">
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${matchScore}%</div>
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
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${missingCount}</div>
        <div style="font-size:11px;opacity:0.8;">Missing</div>
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
    console.log(`✅ Audit completed. ${passCount} passed, ${failedIssues.length} issues (${missingCount} missing) — across ${spatialTokens.length} elements.`);
  } catch (error) {
    console.error('❌ Audit failed:', error);
    fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
