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

    // Extract frame metadata safely — prefer env var (from worker→GitHub dispatch)
    const frameName = process.env.FRAME_NAME || (figmaTokens[0] && figmaTokens[0]._frameName) || 'Selected Frame';
    const frameWidth = (figmaTokens[0] && figmaTokens[0]._frameWidth) || 1440;
    const frameHeight = (figmaTokens[0] && figmaTokens[0]._frameHeight) || 900;

    // Filter out metadata tokens for real analysis
    const designTokens = figmaTokens.filter(t => !t.name?.startsWith('_'));

    // ══════════════════════════════════════════
    // PHASE 0: Navigation
    // ══════════════════════════════════════════
    console.log(`🌸 Starting Visual Engine Audit for: ${targetUrl}`);
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
    
    // Evaluate CSS properties by POSITION-BASED matching
    // Instead of querySelector (Figma names never match DOM), we use elementFromPoint
    // at the Figma token's (x, y) coordinates to find the real live DOM element.
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
      function getElementName(el) {
        if (!el) return 'Unknown';
        if (el.tagName === 'IMG') return el.alt || 'Image';
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return (el.textContent?.trim().substring(0, 30) || 'Button');
        if (el.tagName === 'A') return 'Link: ' + (el.textContent?.trim().substring(0, 25) || 'Link');
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.placeholder || el.name || 'Input Field';
        if (el.tagName === 'NAV') return 'Navigation';
        if (el.tagName === 'HEADER') return 'Header';
        if (el.tagName === 'FOOTER') return 'Footer';
        if (el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3') return el.tagName + ': ' + (el.textContent?.trim().substring(0, 25) || '');
        if (el.tagName === 'P') return 'Text: ' + (el.textContent?.trim().substring(0, 25) || 'Block');
        if (el.tagName === 'SVG' || el.closest?.('svg')) return 'Icon / SVG';
        if (el.tagName === 'VIDEO') return 'Video';
        if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.split(' ').filter(c => c.length > 0 && c.length < 30)[0];
          if (cls) return el.tagName.toLowerCase() + '.' + cls;
        }
        const text = el.textContent?.trim().substring(0, 25);
        if (text && text.length > 2) return text;
        return el.tagName.toLowerCase();
      }

      const results = [];
      let tokenFailures = 0;
      // === DEDUPLICATION: Track DOM elements already checked ===
      // Multiple Figma tokens can hit the same DOM element — only report each once
      const seenElements = new Map(); // DOM element → index in results
      const checkedPositions = new Set();

      tokens.forEach((design) => {
        const name = design.name || 'unknown';
        // Skip tiny spacer/divider tokens that aren't meaningful UI components
        if ((design.w || 0) < 20 && (design.h || 0) < 20) return;
        
        const cx = (design.x || 0) + (design.w || 0) / 2;
        const cy = (design.y || 0) + (design.h || 0) / 2;
        
        if (cx <= 0 && cy <= 0) return;
        // Wider dedup radius (10px) to avoid checking overlapping tokens
        const posKey = Math.round(cx / 10) + ',' + Math.round(cy / 10);
        if (checkedPositions.has(posKey)) return;
        checkedPositions.add(posKey);
        
        const el = document.elementFromPoint(cx, cy);
        if (!el || el === document.body || el === document.documentElement) return;
        
        // === SKIP IRRELEVANT ELEMENTS ===
        // Skip SVG graphs, charts, canvas, iframes, video — these are dynamic content not relevant to UI audit
        const tag = el.tagName.toUpperCase();
        if (tag === 'CANVAS' || tag === 'IFRAME' || tag === 'VIDEO' || tag === 'AUDIO') return;
        if (tag === 'SVG' || el.closest?.('svg')) return; // Skip SVG icons and graphs
        if (el.closest?.('canvas') || el.closest?.('iframe')) return;
        // Skip elements inside chart containers (common libraries)
        if (el.closest?.('[class*="chart"]') || el.closest?.('[class*="graph"]') || el.closest?.('[class*="recharts"]') || el.closest?.('[class*="highcharts"]') || el.closest?.('[class*="apexcharts"]')) return;

        const live = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        // Skip off-screen or invisible elements
        if (rect.width < 5 || rect.height < 5) return;
        const elName = getElementName(el);
        const errors = [];

        // ── FONT SIZE ── (structured diff format)
        if (design.fs && design.fs !== 'Mixed') {
          const liveSize = parseFloat(live.fontSize);
          const diff = Math.round(liveSize - design.fs);
          if (Math.abs(diff) > 0.5) errors.push(`Font Size: Figma ${design.fs}px → Live ${liveSize}px (Δ ${diff > 0 ? '+' : ''}${diff}px)`);
        }
        // ── FONT FAMILY ──
        if (design.ff && design.ff !== 'Mixed' && live.fontFamily) {
          const liveFF = live.fontFamily.split(',')[0].trim().replace(/["']/g, '');
          if (!live.fontFamily.toLowerCase().includes(design.ff.toLowerCase())) {
            errors.push(`Font Family: Figma "${design.ff}" → Live "${liveFF}"`);
          }
        }
        // ── FONT WEIGHT ──
        if (design.fw && design.fw !== 'Mixed') {
          const weightMap = { 'Thin': '100', 'ExtraLight': '200', 'Light': '300', 'Regular': '400', 'Medium': '500', 'SemiBold': '600', 'Bold': '700', 'ExtraBold': '800', 'Black': '900' };
          const expectedWeight = weightMap[design.fw] || design.fw;
          if (live.fontWeight !== expectedWeight && live.fontWeight !== String(expectedWeight)) {
            errors.push(`Font Weight: Figma ${expectedWeight} → Live ${live.fontWeight}`);
          }
        }
        // ── TEXT COLOR ──
        if (design.color) {
          if (!colorsMatchBrowser(design.color, live.color)) {
            errors.push(`Text Color: Figma ${design.color.toLowerCase()} → Live ${parseColorBrowser(live.color)}`);
          }
        }
        // ── BACKGROUND COLOR ──
        if (design.bg && design.bg.length > 0) {
          const liveBg = parseColorBrowser(live.backgroundColor);
          if (liveBg && liveBg !== 'transparent' && liveBg !== 'rgba(0, 0, 0, 0)' && !colorsMatchBrowser(design.bg[0], live.backgroundColor)) {
            errors.push(`Background: Figma ${design.bg[0].toLowerCase()} → Live ${liveBg}`);
          }
        }
        // ── BORDER RADIUS ──
        if (design.br !== undefined && design.br !== 'Mixed' && design.br > 0) {
          const liveRadius = parseFloat(live.borderRadius) || 0;
          const diff = Math.round(liveRadius - design.br);
          if (Math.abs(diff) > 1) errors.push(`Border Radius: Figma ${design.br}px → Live ${liveRadius}px (Δ ${diff > 0 ? '+' : ''}${diff}px)`);
        }
        // ── LETTER SPACING ──
        if (design.ls !== undefined && design.ls !== 'Mixed') {
          const liveLs = live.letterSpacing === 'normal' ? 0 : parseFloat(live.letterSpacing) || 0;
          const expectedLs = typeof design.ls === 'number' ? design.ls : 0;
          if (Math.abs(liveLs - expectedLs) > 0.5) errors.push(`Letter Spacing: Figma ${expectedLs}px → Live ${liveLs}px`);
        }
        // ── LINE HEIGHT ──
        if (design.lh !== undefined && design.lh !== 'Mixed') {
          const liveLh = live.lineHeight === 'normal' ? 0 : parseFloat(live.lineHeight) || 0;
          const expectedLh = typeof design.lh === 'number' ? design.lh : 0;
          if (expectedLh > 0 && liveLh > 0 && Math.abs(liveLh - expectedLh) > 1) {
            const diff = Math.round(liveLh - expectedLh);
            errors.push(`Line Height: Figma ${expectedLh}px → Live ${liveLh}px (Δ ${diff > 0 ? '+' : ''}${diff}px)`);
          }
        }
        // ── TEXT ALIGN ──
        if (design.ta && design.ta !== 'Mixed') {
          const ta = design.ta.toLowerCase();
          const expected = ta === 'justified' ? 'justify' : ta;
          if (live.textAlign !== expected) errors.push(`Text Align: Figma ${expected} → Live ${live.textAlign}`);
        }
        // ── TEXT DECORATION ──
        if (design.td && design.td !== 'Mixed') {
          const expected = design.td === 'strikethrough' ? 'line-through' : design.td;
          if (!live.textDecoration.includes(expected)) errors.push(`Text Decoration: Figma ${expected} → Live ${live.textDecoration.split(' ')[0]}`);
        }
        // ── TEXT TRANSFORM ──
        if (design.tt && design.tt !== 'Mixed') {
          if (live.textTransform !== design.tt) errors.push(`Text Transform: Figma ${design.tt} → Live ${live.textTransform}`);
        }
        // ── OPACITY ──
        if (design.op !== undefined && design.op < 1) {
          const liveOp = parseFloat(live.opacity);
          if (Math.abs(liveOp - design.op) > 0.05) errors.push(`Opacity: Figma ${design.op} → Live ${liveOp}`);
        }
        // ── BORDER WIDTH ──
        if (design.bw !== undefined && design.bw > 0) {
          const liveBw = parseFloat(live.borderWidth) || 0;
          if (Math.abs(liveBw - design.bw) > 0.5) errors.push(`Border Width: Figma ${design.bw}px → Live ${liveBw}px`);
        }
        // ── BORDER COLOR ──
        if (design.bc) {
          if (!colorsMatchBrowser(design.bc, live.borderColor)) {
            errors.push(`Border Color: Figma ${design.bc.toLowerCase()} → Live ${parseColorBrowser(live.borderColor)}`);
          }
        }
        // ── PADDING ──
        if (design.pad && Array.isArray(design.pad)) {
          const [pt, pr, pb, pl] = design.pad;
          const sides = [
            { name: 'Top', figma: pt, live: parseFloat(live.paddingTop) || 0 },
            { name: 'Right', figma: pr, live: parseFloat(live.paddingRight) || 0 },
            { name: 'Bottom', figma: pb, live: parseFloat(live.paddingBottom) || 0 },
            { name: 'Left', figma: pl, live: parseFloat(live.paddingLeft) || 0 },
          ];
          sides.forEach(s => {
            if (s.figma > 0) {
              const diff = Math.round(s.live - s.figma);
              if (Math.abs(diff) > 1) errors.push(`Padding ${s.name}: Figma ${s.figma}px → Live ${s.live}px (Δ ${diff > 0 ? '+' : ''}${diff}px)`);
            }
          });
        }
        // ── GAP ──
        if (design.gap !== undefined) {
          const liveGap = live.gap === 'normal' ? 0 : parseFloat(live.gap) || 0;
          const diff = Math.round(liveGap - design.gap);
          if (Math.abs(diff) > 1) errors.push(`Gap: Figma ${design.gap}px → Live ${liveGap}px (Δ ${diff > 0 ? '+' : ''}${diff}px)`);
        }
        // ── WIDTH / HEIGHT ──
        if (design.w !== undefined && design.w > 0) {
          const diff = Math.round(rect.width - design.w);
          if (Math.abs(diff) > 2) errors.push(`Width: Figma ${design.w}px → Live ${Math.round(rect.width)}px (Δ ${diff > 0 ? '+' : ''}${diff}px)`);
        }
        if (design.h !== undefined && design.h > 0) {
          const diff = Math.round(rect.height - design.h);
          if (Math.abs(diff) > 2) errors.push(`Height: Figma ${design.h}px → Live ${Math.round(rect.height)}px (Δ ${diff > 0 ? '+' : ''}${diff}px)`);
        }

        if (errors.length > 0) {
          // === DEDUP: check if this DOM element was already reported ===
          // Use a unique key based on element tag + position to detect same element
          const elKey = `${tag}_${Math.round(rect.left)}_${Math.round(rect.top)}_${Math.round(rect.width)}`;
          if (seenElements.has(elKey)) {
            // Merge errors into existing issue
            const existingIdx = seenElements.get(elKey);
            const existing = results[existingIdx];
            if (existing) {
              // Add new errors that aren't already listed
              errors.forEach(e => {
                if (!existing.details.includes(e)) existing.details.push(e);
              });
            }
            return; // Don't create a new issue
          }

          const layoutErrors = errors.filter(e => e.startsWith('Width:') || e.startsWith('Height:'));
          const styleErrors = errors.filter(e => !e.startsWith('Width:') && !e.startsWith('Height:'));
          
          tokenFailures++;
          
          if (layoutErrors.length > 0) {
            const idx = results.length;
            seenElements.set(elKey, idx);
            results.push({
              type: 'LAYOUT_SHIFT',
              element: elName,
              details: layoutErrors,
              rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
            });
          }
          if (styleErrors.length > 0) {
            const idx = results.length;
            if (!seenElements.has(elKey)) seenElements.set(elKey, idx);
            results.push({
              type: 'MINOR_DIFF',
              element: elName,
              details: styleErrors,
              rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
            });
          }
        } else {
          results.push({ type: 'TOKEN_PASS', element: elName });
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
    let pixelMatchPercent = 100; // default if no Figma image
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

        const mismatchedPixels = pixelmatch(cropFigma, cropLive, rawDiff.data, width, height, { threshold: 0.15 });
        const totalPixels = width * height;
        pixelMatchPercent = Math.round(((totalPixels - mismatchedPixels) / totalPixels) * 100);
        console.log(`🔍 Pixelmatch: ${mismatchedPixels} differing pixels out of ${totalPixels} (${pixelMatchPercent}% match).`);

        // --- GRID CLUSTERING ALGORITHM ---
        // Small grid (10px) for per-component precision
        const GRID_SIZE = 10;
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
                if (grid[r][c] > 15 && !visited[r][c]) { // 15 pixels min to care about a cell
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
                                  if (grid[nr][nc] > 15 && !visited[nr][nc]) {
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

        // Merge overlapping or close clusters (20px padding for section-level grouping)
        for (let i = 0; i < clusters.length; i++) {
            for (let j = i + 1; j < clusters.length; j++) {
                const c1 = clusters[i], c2 = clusters[j];
                if (!c1 || !c2) continue;
                const padding = 20;
                if (c1.x < c2.x + c2.w + padding && c1.x + c1.w + padding > c2.x &&
                    c1.y < c2.y + c2.h + padding && c1.y + c1.h + padding > c2.y) {
                    
                    const newX = Math.min(c1.x, c2.x);
                    const newY = Math.min(c1.y, c2.y);
                    c1.w = Math.max(c1.x + c1.w, c2.x + c2.w) - newX;
                    c1.h = Math.max(c1.y + c1.h, c2.y + c2.h) - newY;
                    c1.x = newX;
                    c1.y = newY;
                    clusters[j] = null;
                }
            }
        }

        // Filter out tiny boxes (noise) — show ALL real errors
        const finalClusters = clusters.filter(c => c !== null && c.w > 15 && c.h > 15);
        console.log(`📦 Grouped visual errors into ${finalClusters.length} bounding boxes.`);

        // --- SMART BOX ANALYSIS: identify DOM element + classify error type ---
        // We need to pass these box rects to page.evaluate to identify what DOM
        // element lives at the center of each box.
        const boxNames = await page.evaluate((boxes) => {
          return boxes.map(box => {
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            const el = document.elementFromPoint(cx, cy);
            if (!el) return 'Unknown Element';
            // Build a readable name
            if (el.tagName === 'IMG') return el.alt || 'Image';
            if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return el.textContent?.trim().substring(0, 30) || 'Button';
            if (el.tagName === 'A') return 'Link: ' + (el.textContent?.trim().substring(0, 25) || el.href?.substring(0, 30) || 'Link');
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.placeholder || el.name || 'Input Field';
            if (el.tagName === 'NAV') return 'Navigation Bar';
            if (el.tagName === 'HEADER') return 'Header Section';
            if (el.tagName === 'FOOTER') return 'Footer Section';
            if (el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3') return 'Heading: ' + (el.textContent?.trim().substring(0, 30) || el.tagName);
            if (el.tagName === 'P') return 'Text Block';
            if (el.tagName === 'SVG' || el.closest('svg')) return 'Icon / SVG';
            if (el.tagName === 'VIDEO') return 'Video Player';
            // Use class or id for generic divs/sections
            if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
            if (el.className && typeof el.className === 'string') {
              const cls = el.className.split(' ').filter(c => c.length > 0 && c.length < 30)[0];
              if (cls) return el.tagName.toLowerCase() + '.' + cls;
            }
            const text = el.textContent?.trim().substring(0, 30);
            if (text && text.length > 2) return text;
            return el.tagName.toLowerCase() + ' element';
          });
        }, finalClusters);

        // Analyze pixel color differences in each box region to classify the error
        finalClusters.forEach((box, idx) => {
            // Sample average colors in Figma vs Live within this box
            let figmaR = 0, figmaG = 0, figmaB = 0, liveR = 0, liveG = 0, liveB = 0;
            let sampleCount = 0;
            const step = Math.max(2, Math.floor(Math.min(box.w, box.h) / 5));
            for (let sy = box.y; sy < box.y + box.h && sy < height; sy += step) {
                for (let sx = box.x; sx < box.x + box.w && sx < width; sx += step) {
                    const pidx = (width * sy + sx) << 2;
                    figmaR += cropFigma[pidx]; figmaG += cropFigma[pidx+1]; figmaB += cropFigma[pidx+2];
                    liveR += cropLive[pidx]; liveG += cropLive[pidx+1]; liveB += cropLive[pidx+2];
                    sampleCount++;
                }
            }

            let reason = 'Visual differences detected in this area.';
            if (sampleCount > 0) {
                figmaR = Math.round(figmaR / sampleCount);
                figmaG = Math.round(figmaG / sampleCount);
                figmaB = Math.round(figmaB / sampleCount);
                liveR = Math.round(liveR / sampleCount);
                liveG = Math.round(liveG / sampleCount);
                liveB = Math.round(liveB / sampleCount);

                const colorDiff = Math.abs(figmaR - liveR) + Math.abs(figmaG - liveG) + Math.abs(figmaB - liveB);
                const figmaBrightness = (figmaR + figmaG + figmaB) / 3;
                const liveBrightness = (liveR + liveG + liveB) / 3;
                const brightDiff = Math.abs(figmaBrightness - liveBrightness);

                const fHex = `#${figmaR.toString(16).padStart(2,'0')}${figmaG.toString(16).padStart(2,'0')}${figmaB.toString(16).padStart(2,'0')}`;
                const lHex = `#${liveR.toString(16).padStart(2,'0')}${liveG.toString(16).padStart(2,'0')}${liveB.toString(16).padStart(2,'0')}`;

                if (brightDiff > 120) {
                    reason = `Missing or extra content (Figma avg: ${fHex}, Live avg: ${lHex}). A component may have been added or removed.`;
                } else if (colorDiff > 80) {
                    reason = `Color mismatch (Figma avg: ${fHex}, Live avg: ${lHex}). Background, button, or element color differs from design.`;
                } else {
                    reason = `Shape/spacing difference (Figma avg: ${fHex}, Live avg: ${lHex}). Subtle layout or styling deviation.`;
                }
            }

            visualIssues.push({
                type: 'MAJOR_VISUAL',
                element: boxNames[idx] || 'Visual Mismatch Region',
                details: [reason],
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
    
    // combine all issues
    const tokenMinor = tokenReport.filter(r => r.type === 'MINOR_DIFF');
    const tokenLayout = tokenReport.filter(r => r.type === 'LAYOUT_SHIFT');
    
    // === FILTER VISUAL ISSUES: skip pixelmatch boxes that overlap with already-detected token issues ===
    const tokenRects = [...tokenMinor, ...tokenLayout].map(r => r.rect);
    const filteredVisual = visualIssues.filter(vi => {
      // If a visual box significantly overlaps a token-detected box, skip it (already reported)
      for (const tr of tokenRects) {
        const overlapX = Math.max(0, Math.min(vi.rect.x + vi.rect.w, tr.x + tr.w) - Math.max(vi.rect.x, tr.x));
        const overlapY = Math.max(0, Math.min(vi.rect.y + vi.rect.h, tr.y + tr.h) - Math.max(vi.rect.y, tr.y));
        const overlapArea = overlapX * overlapY;
        const viArea = vi.rect.w * vi.rect.h;
        if (viArea > 0 && overlapArea / viArea > 0.3) return false; // 30%+ overlap = skip
      }
      return true;
    });
    
    let allIssues = [...tokenMinor, ...tokenLayout, ...filteredVisual];
    
    // Sort issues top-to-bottom (by Y position) so header = #1, footer = last
    allIssues.sort((a, b) => a.rect.y - b.rect.y);
    
    // Assign issue numbers sequentially (now in top-to-bottom order)
    allIssues.forEach((issue, index) => {
        issue.issueNum = index + 1;
    });

    // Use the REAL pixel-level match score
    const matchScore = pixelMatchPercent;
    const tokenPassCount = tokenReport.filter(r => r.type === 'TOKEN_PASS').length;

    // 1. Draw markers on the live page via page.evaluate
    await page.evaluate((issues) => {
        issues.forEach(issue => {
            // Single clean blue for all issue types
            const color = '#3B82F6';
            const bgColor = 'rgba(59,130,246,0.04)';
            
            // Add 6px padding to bounding box
            const bx = Math.max(0, issue.rect.x - 6);
            const by = Math.max(0, issue.rect.y - 6);
            const bw = issue.rect.w + 12;
            const bh = issue.rect.h + 12;

            const box = document.createElement('div');
            box.style.cssText = `
              position: absolute; z-index: 10000; pointer-events: none;
              top: ${by}px; left: ${bx}px;
              width: ${bw}px; height: ${bh}px;
              border: 2px solid ${color};
              background: ${bgColor};
            `;
            document.body.appendChild(box);

            // Badge: placed INSIDE the box at top-left corner (always visible, never clips)
            const badge = document.createElement('div');
            badge.textContent = String(issue.issueNum);
            badge.style.cssText = `
              position: absolute; z-index: 10001; pointer-events: none;
              top: ${by + 4}px; left: ${bx + 4}px;
              min-width: 22px; height: 22px; padding: 0 5px;
              background: ${color}; color: white; border-radius: 11px;
              font-family: -apple-system, sans-serif; font-size: 11px; font-weight: 700;
              display: flex; align-items: center; justify-content: center;
              box-shadow: 0 1px 4px rgba(0,0,0,0.3);
            `;
            document.body.appendChild(badge);

            // Element name label below the badge
            const label = document.createElement('div');
            label.textContent = issue.element;
            label.style.cssText = `
              position: absolute; z-index: 10001; pointer-events: none;
              top: ${by + 4}px; left: ${bx + 30}px;
              height: 22px; padding: 0 8px;
              background: ${color}; color: white; border-radius: 4px;
              font-family: -apple-system, sans-serif; font-size: 10px; font-weight: 600;
              display: flex; align-items: center;
              box-shadow: 0 1px 4px rgba(0,0,0,0.3);
              max-width: ${Math.max(bw - 40, 80)}px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
            `;
            document.body.appendChild(label);
        });
    }, allIssues);

    // 2. Take annotated screenshot
    const annotatedBuffer = await page.screenshot({ fullPage: true });
    const screenshotBase64 = annotatedBuffer.toString('base64');
    const auditDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // 3. Build Issue HTML List — structured Figma→Live diff format
    const issueRows = allIssues.map((issue) => {
      const labelMap = { 'MAJOR_VISUAL': 'Visual Mismatch', 'LAYOUT_SHIFT': 'Layout Shift', 'MINOR_DIFF': 'Design Diff' };
      const color = '#3B82F6';
      const label = labelMap[issue.type] || 'Issue';
      // Format each detail as a separate row with arrow styling
      const detailRows = issue.details.map(d => 
        `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#475569;">${d}</div>`
      ).join('');
      return `
      <div style="display:flex;gap:14px;padding:16px;margin:0 0 10px;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,0.06);border-left:4px solid ${color};">
        <div style="min-width:32px;height:32px;background:${color};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">${issue.issueNum}</div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:15px;color:#0f1b35;margin-bottom:6px;">${label} &middot; ${issue.element}</div>
          <div style="background:#f8fafc;padding:8px 12px;border-radius:8px;">${detailRows}</div>
          <div style="color:#94a3b8;font-size:11px;margin-top:6px;">📍 Area: ${issue.rect.w}×${issue.rect.h}px at (${issue.rect.x}, ${issue.rect.y})</div>
        </div>
      </div>
    `}).join('');

    // 4. Build Final Output HTML — 2 KPI cards only + padded screenshot
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
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:100px;">
        <div style="font-size:28px;font-weight:800;">${matchScore}%</div>
        <div style="font-size:11px;opacity:0.8;">True Match Score</div>
      </div>
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;min-width:100px;">
        <div style="font-size:28px;font-weight:800;">${allIssues.length}</div>
        <div style="font-size:11px;opacity:0.8;">Issues Found</div>
      </div>
    </div>
  </div>
  


  <div style="padding:32px 48px;">
    <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">📸 Audit Screenshot</h2>
    <div style="padding:12px;background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,0.1);border:1px solid #e2e8f0;">
      <img src="data:image/png;base64,${screenshotBase64}" style="width:100%;display:block;border-radius:8px;" />
    </div>
  </div>
  <div style="padding:0 48px 48px;">
    <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">🔍 Discrepancy Log</h2>
    ${allIssues.length > 0 ? issueRows : '<div style="padding:24px;background:#f0fdf4;border-radius:12px;color:#16a34a;font-weight:600;text-align:center;">✅ Perfect Match! No visual or CSS rules failed.</div>'}
  </div>
</body></html>`;

    // 5. Render final PDF report via Playwright
    const reportPage = await browser.newPage();
    await reportPage.setViewportSize({ width: 1200, height: 800 });
    await reportPage.setContent(reportHtml, { waitUntil: 'load' });
    await reportPage.waitForTimeout(500);
    // Generate PDF for crisp text and smaller file size
    await reportPage.pdf({ 
      path: 'playwright-report/visual-audit-diff.pdf', 
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
    // Also keep a PNG for backward compatibility (email attachments, etc.)
    await reportPage.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
    await reportPage.close();
    console.log('� Visual report saved as visual-audit-diff.pdf + .png');

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
