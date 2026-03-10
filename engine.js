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

    // Extract frame metadata safely
    const frameName = (figmaTokens[0] && figmaTokens[0]._frameName) || 'Selected Frame';
    const frameWidth = (figmaTokens[0] && figmaTokens[0]._frameWidth) || 1440;
    const frameHeight = (figmaTokens[0] && figmaTokens[0]._frameHeight) || 900;

    // Filter out metadata tokens for real analysis
    const designTokens = figmaTokens.filter(t => !t.name?.startsWith('_'));

    // ══════════════════════════════════════════
    // PHASE 0: Navigation
    // ══════════════════════════════════════════
    console.log(`🌸 Starting Hybrid Visual Engine Audit for: ${targetUrl}`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Force viewport to match Figma frame width exactly to prevent responsive breaking
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

    // Wait, scroll down to load images, scroll up
    console.log('⏳ Waiting for animations to settle...');
    await page.addStyleTag({ content: '::-webkit-scrollbar { display: none !important; } * { scrollbar-width: none !important; }' });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const distance = 300; const delay = 100;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          if (window.scrollY + window.innerHeight >= document.body.scrollHeight) {
            clearInterval(timer); resolve();
          }
        }, delay);
      });
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);
    console.log('✅ Page settled.');

    // ══════════════════════════════════════════
    // PHASE 1: TOKEN CSS VALIDATION
    // ══════════════════════════════════════════
    console.log('🔍 Running CSS Token Validation...');
    
    // Evaluate CSS properties on matched DOM elements
    const tokenReport = await page.evaluate((tokens) => {
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
      let tokenFailures = 0;

      tokens.forEach((design) => {
        const name = design.name || 'unknown';
        const escaped = CSS.escape(name);
        // Find by testid, name attribute, or class name (Hybrid strategy matches)
        const el = document.querySelector(`[data-testid="${name}"]`) || 
                   document.querySelector(`[name="${name}"]`) || 
                   document.querySelector(`.${escaped}`);

        // If skipped/not found, we ignore. Pixelmatch catches missing things.
        if (!el) return;

        const live = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const errors = [];

        // ── TYPOGRAPHY & DESIGN CHECKS ──
        if (design.fs && design.fs !== 'Mixed') {
          const liveSize = parseFloat(live.fontSize);
          if (Math.abs(liveSize - design.fs) > 0.5) errors.push(`Font Size: ${liveSize}px (Expected ${design.fs}px)`);
        }
        if (design.ff && design.ff !== 'Mixed' && live.fontFamily) {
          if (!live.fontFamily.toLowerCase().includes(design.ff.toLowerCase())) {
            errors.push(`Font Family: ${live.fontFamily.split(',')[0].trim()} (Expected ${design.ff})`);
          }
        }
        if (design.fw && design.fw !== 'Mixed') {
          const weightMap = { 'Thin': '100', 'ExtraLight': '200', 'Light': '300', 'Regular': '400', 'Medium': '500', 'SemiBold': '600', 'Bold': '700', 'ExtraBold': '800', 'Black': '900' };
          const expectedWeight = weightMap[design.fw] || design.fw;
          if (live.fontWeight !== expectedWeight && live.fontWeight !== String(expectedWeight)) {
            errors.push(`Font Weight: ${live.fontWeight} (Expected ${expectedWeight})`);
          }
        }
        if (design.color) {
          if (!colorsMatchBrowser(design.color, live.color)) {
            errors.push(`Text Color: ${parseColorBrowser(live.color)} (Expected ${design.color.toLowerCase()})`);
          }
        }
        if (design.bg && design.bg.length > 0) {
          const liveBg = parseColorBrowser(live.backgroundColor);
          if (liveBg && liveBg !== 'transparent' && liveBg !== 'rgba(0, 0, 0, 0)' && !colorsMatchBrowser(design.bg[0], live.backgroundColor)) {
            errors.push(`Background: ${liveBg} (Expected ${design.bg[0].toLowerCase()})`);
          }
        }
        if (design.br !== undefined && design.br !== 'Mixed' && design.br > 0) {
          const liveRadius = parseFloat(live.borderRadius) || 0;
          if (Math.abs(liveRadius - design.br) > 1) errors.push(`Border Radius: ${liveRadius}px (Expected ${design.br}px)`);
        }
        
        if (errors.length > 0) {
          tokenFailures++;
          results.push({
            type: 'TOKEN_FAIL',
            element: name,
            details: errors,
            rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
          });
        } else {
          results.push({ type: 'TOKEN_PASS', element: name });
        }
      });
      return results;
    }, designTokens);

    // ══════════════════════════════════════════
    // PHASE 2: VISUAL PIXEL MATCH & CLUSTERING
    // ══════════════════════════════════════════
    console.log('📸 Taking live screenshot...');
    const liveScreenshotBuffer = await page.screenshot({ fullPage: true });
    fs.writeFileSync('playwright-report/live-screenshot.png', liveScreenshotBuffer);

    let visualIssues = [];
    const figmaImagePath = process.env.FIGMA_IMAGE;

    if (figmaImagePath && fs.existsSync(figmaImagePath)) {
      console.log('🖼️ Running Pixelmatch Bounding Box Clustering...');
      try {
        const { PNG } = require('pngjs');
        const pixelmatchModule = require('pixelmatch');
        const pixelmatch = pixelmatchModule.default || pixelmatchModule;

        const imgFigma = PNG.sync.read(fs.readFileSync(figmaImagePath));
        const imgLive = PNG.sync.read(liveScreenshotBuffer);

        const width = Math.min(imgFigma.width, imgLive.width);
        const height = Math.min(imgFigma.height, imgLive.height);

        const cropFigma = new Uint8Array(width * height * 4);
        const cropLive = new Uint8Array(width * height * 4);
        const rawDiff = new PNG({ width, height });

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idxF = (imgFigma.width * y + x) << 2;
                const idxL = (imgLive.width * y + x) << 2;
                const idxDst = (width * y + x) << 2;

                cropFigma[idxDst] = imgFigma.data[idxF]; cropFigma[idxDst+1] = imgFigma.data[idxF+1];
                cropFigma[idxDst+2] = imgFigma.data[idxF+2]; cropFigma[idxDst+3] = imgFigma.data[idxF+3];

                cropLive[idxDst] = imgLive.data[idxL]; cropLive[idxDst+1] = imgLive.data[idxL+1];
                cropLive[idxDst+2] = imgLive.data[idxL+2]; cropLive[idxDst+3] = imgLive.data[idxL+3];
            }
        }

        const mismatchedPixels = pixelmatch(cropFigma, cropLive, rawDiff.data, width, height, { threshold: 0.1 });
        console.log(`🔍 Pixelmatch found ${mismatchedPixels} differing pixels.`);

        // --- GRID CLUSTERING ALGORITHM ---
        // We divide the screen into a 30x30 grid. If a grid cell has enough red pixels, we mark it "hot".
        const GRID_SIZE = 30;
        const cols = Math.ceil(width / GRID_SIZE);
        const rows = Math.ceil(height / GRID_SIZE);
        const grid = Array(rows).fill(0).map(() => Array(cols).fill(0));

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (width * y + x) << 2;
                // If pixel is red (mismatched)
                if (rawDiff.data[idx] === 255 && rawDiff.data[idx+1] === 0 && rawDiff.data[idx+2] === 0) {
                    const gx = Math.floor(x / GRID_SIZE);
                    const gy = Math.floor(y / GRID_SIZE);
                    grid[gy][gx]++;
                }
            }
        }

        // Find connected components (Bounding Boxes) of hot grid cells
        const visited = Array(rows).fill(0).map(() => Array(cols).fill(false));
        const clusters = [];
        
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (grid[r][c] > 10 && !visited[r][c]) { // 10 pixels min to care about a cell
                    // DFS to find cluster bounds
                    let minR = r, maxR = r, minC = c, maxC = c;
                    const stack = [[r, c]];
                    visited[r][c] = true;
                    
                    while (stack.length > 0) {
                        const [currR, currC] = stack.pop();
                        minR = Math.min(minR, currR); maxR = Math.max(maxR, currR);
                        minC = Math.min(minC, currC); maxC = Math.max(maxC, currC);
                        
                        // Check 8 neighbors
                        for (let dr = -1; dr <= 1; dr++) {
                            for (let dc = -1; dc <= 1; dc++) {
                                const nr = currR + dr, nc = currC + dc;
                                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                                  if (grid[nr][nc] > 10 && !visited[nr][nc]) {
                                      visited[nr][nc] = true;
                                      stack.push([nr, nc]);
                                  }
                                }
                            }
                        }
                    }
                    
                    // Convert grid bounds back to pixel bounds
                    clusters.push({
                        x: minC * GRID_SIZE,
                        y: minR * GRID_SIZE,
                        w: (maxC - minC + 1) * GRID_SIZE,
                        h: (maxR - minR + 1) * GRID_SIZE
                    });
                }
            }
        }

        // Merge overlapping or very close clusters
        for (let i = 0; i < clusters.length; i++) {
            for (let j = i + 1; j < clusters.length; j++) {
                const c1 = clusters[i], c2 = clusters[j];
                if (!c1 || !c2) continue;
                // Expand slightly for merge check
                const padding = 40;
                if (c1.x < c2.x + c2.w + padding && c1.x + c1.w + padding > c2.x &&
                    c1.y < c2.y + c2.h + padding && c1.y + c1.h + padding > c2.y) {
                    
                    c1.x = Math.min(c1.x, c2.x);
                    c1.y = Math.min(c1.y, c2.y);
                    c1.w = Math.max(c1.x + c1.w, c2.x + c2.w) - c1.x;
                    c1.h = Math.max(c1.y + c1.h, c2.y + c2.h) - c1.y;
                    clusters[j] = null; // Mark for deletion
                }
            }
        }

        const finalClusters = clusters.filter(c => c !== null);
        console.log(`📦 Grouped visual errors into ${finalClusters.length} bounding boxes.`);

        finalClusters.forEach(box => {
            visualIssues.push({
                type: 'VISUAL_FAIL',
                element: 'Visual Mismatch Region',
                details: ['Structural or component differences detected in this area (missing/extra components or layout shift).'],
                rect: box
            });
        });

      } catch (err) {
        console.error('⚠️ Visual clustering failed:', err);
      }
    }

    // ══════════════════════════════════════════
    // PHASE 3: REPORT GENERATION
    // ══════════════════════════════════════════
    console.log('🖨️ Generating Professional HTML Report...');
    
    // Combine token failures and visual failures
    const tokenFailures = tokenReport.filter(r => r.type === 'TOKEN_FAIL');
    let allIssues = [...tokenFailures, ...visualIssues];
    
    // Assign issue numbers sequentially
    allIssues.forEach((issue, index) => {
        issue.issueNum = index + 1;
    });

    // Compute REAL Match Score (Passes vs Fails)
    const tokenPassCount = tokenReport.filter(r => r.type === 'TOKEN_PASS').length;
    // Score Formula: Valid matched tokens / (Valid matched tokens + Broken Tokens + Huge Visual Regions)
    const totalChecks = tokenPassCount + tokenFailures.length + visualIssues.length;
    const matchScore = totalChecks > 0 ? Math.round((tokenPassCount / totalChecks) * 100) : 0;

    // We need to inject the CSS for the markers onto the live page, take the marked screenshot, and then build the full report page.
    // 1. Draw markers on the live page via page.evaluate
    await page.evaluate((issues) => {
        issues.forEach(issue => {
            const box = document.createElement('div');
            box.style.cssText = `
              position: absolute; z-index: 10000; pointer-events: none;
              top: ${issue.rect.y}px; left: ${issue.rect.x}px;
              width: ${issue.rect.w}px; height: ${issue.rect.h}px;
              border: 2px dashed ${issue.type === 'VISUAL_FAIL' ? '#FF9500' : '#FF3B30'};
              background: ${issue.type === 'VISUAL_FAIL' ? 'rgba(255, 149, 0, 0.05)' : 'rgba(255, 59, 48, 0.05)'};
            `;
            document.body.appendChild(box);

            const badge = document.createElement('div');
            badge.textContent = String(issue.issueNum);
            badge.style.cssText = `
              position: absolute; z-index: 10001; pointer-events: none;
              top: ${issue.rect.y - 14}px; left: ${issue.rect.x - 14}px;
              width: 28px; height: 28px;
              background: ${issue.type === 'VISUAL_FAIL' ? '#FF9500' : '#FF3B30'}; color: white; border-radius: 50%;
              font-family: -apple-system, sans-serif; font-size: 13px; font-weight: 700;
              display: flex; align-items: center; justify-content: center;
              box-shadow: 0 2px 8px rgba(0,0,0,0.35); border: 2.5px solid white;
            `;
            document.body.appendChild(badge);
        });
    }, allIssues);

    // 2. Take annotated screenshot
    const annotatedBuffer = await page.screenshot({ fullPage: true });
    const screenshotBase64 = annotatedBuffer.toString('base64');
    const auditDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // 3. Build Issue HTML List
    const issueRows = allIssues.map((issue) => {
      const color = issue.type === 'VISUAL_FAIL' ? '#FF9500' : '#FF3B30';
      const icon = issue.type === 'VISUAL_FAIL' ? '🖼️' : '🎨';
      const label = issue.type === 'VISUAL_FAIL' ? 'Visual Diff' : 'Design Rule';
      return `
      <div style="display:flex;gap:14px;padding:16px;margin:0 0 10px;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,0.06);border-left:4px solid ${color};">
        <div style="min-width:32px;height:32px;background:${color};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">${issue.issueNum}</div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:15px;color:#0f1b35;margin-bottom:3px;">${icon} ${label} &middot; ${issue.element}</div>
          <div style="color:#64748b;font-size:13px;line-height:1.6;">${issue.details.join(' &middot; ')}</div>
          <div style="color:#94a3b8;font-size:11px;margin-top:4px;">📍 Area bounds: ${issue.rect.w}×${issue.rect.h}px</div>
        </div>
      </div>
    `}).join('');

    // 4. Build Final Output HTML
    const reportHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;">
  <div style="background:linear-gradient(135deg,#0f5ec4 0%,#3da5ff 100%);padding:40px 48px;color:#fff;">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
      <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px;">UI Match</div>
      <div style="font-size:13px;opacity:0.7;border-left:2px solid rgba(255,255,255,0.3);padding-left:16px;">Hybrid Audit Report</div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px 32px;font-size:13px;opacity:0.9;">
      <div>🎨 <strong>Figma Frame:</strong> ${frameName}</div>
      <div>🌍 <strong>Website:</strong> ${targetUrl}</div>
      <div>📅 <strong>Date:</strong> ${auditDate}</div>
      <div>📐 <strong>Viewport Check:</strong> ${frameWidth}×${frameHeight}px</div>
    </div>
    <div style="display:flex;gap:16px;margin-top:24px;">
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${matchScore}%</div>
        <div style="font-size:11px;opacity:0.8;">True Match Score</div>
      </div>
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${allIssues.length}</div>
        <div style="font-size:11px;opacity:0.8;">Issues Found</div>
      </div>
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:80px;">
        <div style="font-size:26px;font-weight:800;">${tokenPassCount}</div>
        <div style="font-size:11px;opacity:0.8;">Passed Rules</div>
      </div>
    </div>
  </div>
  <div style="padding:32px 48px;">
    <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">📸 Audit Screenshot</h2>
    <img src="data:image/png;base64,${screenshotBase64}" style="width:100%;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1);border:1px solid #e2e8f0;" />
  </div>
  <div style="padding:0 48px 48px;">
    <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">🔍 Discrepancy Log</h2>
    ${allIssues.length > 0 ? issueRows : '<div style="padding:24px;background:#f0fdf4;border-radius:12px;color:#16a34a;font-weight:600;text-align:center;">✅ Perfect Match! No visual or CSS rules failed.</div>'}
  </div>
</body></html>`;

    // 5. Render final PNG report via Playwright
    const reportPage = await browser.newPage();
    await reportPage.setViewportSize({ width: 1200, height: 800 });
    await reportPage.setContent(reportHtml, { waitUntil: 'load' });
    await reportPage.waitForTimeout(500);
    await reportPage.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
    await reportPage.close();
    console.log('📸 Hybrid report saved as visual-audit-diff.png');

    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(tokenReport, null, 2));
    console.log(`✅ Audit completed. Score: ${matchScore}%. ${allIssues.length} total issues found.`);

  } catch (error) {
    console.error('❌ Audit failed:', error);
    fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
