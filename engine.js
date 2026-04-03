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
    const WORKER_URL = 'https://ui-match-proxy.soumyasahoo473.workers.dev';
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
    // Force 1x device scale to match Figma's 1:1 pixel mapping
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await context.newPage();

    // Force viewport to match Figma frame width exactly to prevent responsive breaking
    await page.setViewportSize({ width: frameWidth, height: frameHeight });
    console.log(`📐 Viewport set to ${frameWidth}×${frameHeight} @1x (matching Figma frame)`);

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

    // ── FULL ENVIRONMENT NORMALIZATION ──
    console.log('⏳ Normalizing environment...');
    
    // 1. Wait for ALL web fonts to finish loading
    await page.evaluate(() => document.fonts.ready);
    console.log('🔤 Fonts loaded.');
    
    // 2. Freeze ALL animations, transitions, and hide dynamic overlays
    await page.addStyleTag({ content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      ::-webkit-scrollbar { display: none !important; }
      * { scrollbar-width: none !important; }
      [class*="tooltip"], [class*="Tooltip"],
      [class*="toast"], [class*="Toast"],
      [class*="popup"], [class*="Popup"],
      [class*="modal"]:not([class*="page"]),
      [class*="Modal"]:not([class*="page"]),
      [class*="dropdown"]:not(:focus-within),
      [class*="Dropdown"]:not(:focus-within),
      [role="tooltip"], [role="dialog"]:not([aria-modal="true"]) {
        display: none !important;
      }
    `});

    // 3. Blackout images to focus on UI structure
    await page.evaluate(() => {
      const styles = document.createElement('style');
      styles.innerHTML = `
        img, picture, video, canvas, svg:not(.audit-svg), [style*="background-image"] {
          filter: brightness(0) !important;
          background: #000 !important;
          color: transparent !important;
        }
      `;
      document.head.appendChild(styles);
    });

    // 4. Scroll to trigger lazy loading, then scroll back
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
    console.log('✅ Environment normalized — fonts loaded, animations frozen, dynamic content hidden.');

    // === NEW: HUMAN-EYE PRE-CHECK ===
    console.log('👁️ Running Native Structural Pre-check...');
    const figmaFile = process.env.FIGMA_IMAGE || 'figma-frame.png';
    
    if (fs.existsSync(figmaFile)) {
      try {
        const liveFullBuf = await page.screenshot({ fullPage: true });
        const liveBase64 = liveFullBuf.toString('base64');
        const figmaBuf = fs.readFileSync(figmaFile);
        const figmaBase64 = figmaBuf.toString('base64');
        
        // Use native browser canvas to compare the top portion of the screen
        const matchScore = await page.evaluate(async ({fBase, lBase}) => {
            return new Promise((resolve, reject) => {
                const imgF = new Image();
                const imgL = new Image();
                imgF.src = 'data:image/png;base64,' + fBase;
                imgL.src = 'data:image/png;base64,' + lBase;
                
                let loaded = 0;
                imgF.onload = () => { loaded++; if (loaded===2) compare(); };
                imgL.onload = () => { loaded++; if (loaded===2) compare(); };
                imgF.onerror = () => reject('Figma img load failed');
                imgL.onerror = () => reject('Live img load failed');

                function compare() {
                    const w = Math.min(800, imgF.width, imgL.width);
                    const h = Math.min(600, imgF.height, imgL.height);
                    if (w <= 0 || h <= 0) return resolve(100);

                    const canvasF = document.createElement('canvas');
                    const canvasL = document.createElement('canvas');
                    canvasF.width = w; canvasF.height = h;
                    canvasL.width = w; canvasL.height = h;

                    const ctxF = canvasF.getContext('2d', { willReadFrequently: true });
                    const ctxL = canvasL.getContext('2d', { willReadFrequently: true });
                    ctxF.drawImage(imgF, 0, 0, w, h);
                    ctxL.drawImage(imgL, 0, 0, w, h);

                    const dataF = ctxF.getImageData(0, 0, w, h).data;
                    const dataL = ctxL.getImageData(0, 0, w, h).data;
                    
                    let diffPixels = 0;
                    const maxLen = w * h * 4;
                    for (let i = 0; i < maxLen; i += 4) {
                        const rDiff = Math.abs(dataF[i] - dataL[i]);
                        const gDiff = Math.abs(dataF[i+1] - dataL[i+1]);
                        const bDiff = Math.abs(dataF[i+2] - dataL[i+2]);
                        // Simple threshold for structural match: if pixel is drastically different
                        if (rDiff + gDiff + bDiff > 100) {
                            diffPixels++;
                        }
                    }
                    const totalPixels = w * h;
                    const score = 100 - ((diffPixels / totalPixels) * 100);
                    resolve(score);
                }
            });
        }, { fBase: figmaBase64, lBase: liveBase64 });
        
        console.log(`👁️ Native Pre-check Score: ${matchScore.toFixed(2)}%`);

        if (matchScore < 40) {
            console.error(`🚨 STRUCTURAL MISMATCH (Score: ${matchScore.toFixed(1)}%). The Live URL layout is drastically different from the Figma design.`);
            console.error(`Please check if you provided the correct URL or if the page requires login.`);
            fs.writeFileSync('playwright-report/error-log.txt', `Audit Aborted: Structural Mismatch (Score: ${matchScore.toFixed(1)}%). Live URL is drastically different from Figma design.`);
            
            // Render a failure PDF
            const html = `<html><body style="font-family:sans-serif;padding:60px;text-align:center;background:#fff5f5;color:#c53030;">
                <h1 style="font-size:40px;margin-bottom:10px;">🚨 Mismatch Detected</h1>
                <p style="font-size:18px;">The Figma design and the Live URL are structurally too different (${matchScore.toFixed(1)}% match). Please check the URL.</p>
            </body></html>`;
            const errPage = await browser.newPage();
            await errPage.setContent(html);
            await errPage.pdf({ path: 'playwright-report/visual-audit-diff.pdf', printBackground: true });
            await errPage.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });
            await errPage.close();
            
            throw new Error(`Audit Aborted: Structural Mismatch (Score: ${matchScore.toFixed(1)}%). Live URL is drastically different from Figma design.`);
        }
      } catch (e) {
         if (e.message.includes("Abort")) throw e;
         console.warn("⚠️ Native Pre-check skipped/failed: ", e.message);
      }
    }

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
        if (a === b) return true;
        // RGB tolerance: allow ±5 per channel to avoid sub-pixel rendering false flags
        const hexToRgb = (hex) => {
          const h = hex.replace('#', '');
          return [parseInt(h.substring(0,2),16), parseInt(h.substring(2,4),16), parseInt(h.substring(4,6),16)];
        };
        if (a.startsWith('#') && a.length === 7 && b.startsWith('#') && b.length === 7) {
          const [r1,g1,b1] = hexToRgb(a);
          const [r2,g2,b2] = hexToRgb(b);
          return Math.abs(r1-r2) <= 5 && Math.abs(g1-g2) <= 5 && Math.abs(b1-b2) <= 5;
        }
        return false;
      }
      // Walk UP to the nearest top-level/semantic parent component
      function getElementName(el) {
        if (!el) return 'Unknown';
        // Walk up to find the nearest meaningful parent
        let current = el;
        const semanticTags = ['NAV','HEADER','FOOTER','MAIN','ASIDE','SECTION','FORM','TABLE','DIALOG'];
        while (current && current !== document.body && current !== document.documentElement) {
          const tag = current.tagName;
          // Semantic HTML elements
          if (semanticTags.includes(tag)) {
            const names = { 'NAV': 'Navigation', 'HEADER': 'Header', 'FOOTER': 'Footer', 'MAIN': 'Main Content', 'ASIDE': 'Sidebar', 'SECTION': 'Section', 'FORM': 'Form', 'TABLE': 'Table', 'DIALOG': 'Dialog' };
            return names[tag] || tag.toLowerCase();
          }
          // Elements with aria-labels or meaningful roles
          if (current.getAttribute('role')) {
            const role = current.getAttribute('role');
            const roleNames = { 'navigation': 'Navigation', 'banner': 'Header', 'main': 'Main Content', 'contentinfo': 'Footer', 'complementary': 'Sidebar', 'dialog': 'Dialog', 'tablist': 'Tab Bar', 'toolbar': 'Toolbar', 'search': 'Search' };
            if (roleNames[role]) return roleNames[role];
          }
          // Specific interactive elements
          if (tag === 'BUTTON' || current.getAttribute('role') === 'button') return current.textContent?.trim().substring(0, 25) || 'Button';
          if (tag === 'A') return 'Link: ' + (current.textContent?.trim().substring(0, 20) || 'Link');
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return current.placeholder || current.name || 'Input';
          if (tag === 'IMG') return current.alt || 'Image';
          if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') return 'Heading: ' + (current.textContent?.trim().substring(0, 20) || '');
          current = current.parentElement;
        }
        // Fallback: use the original element's info
        if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
        const text = el.textContent?.trim().substring(0, 20);
        if (text && text.length > 2) return text;
        return 'Component';
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

        // Skip image/decorative Figma tokens from Missing Element detection
        // These are visual fills (RECTANGLE with image, icons, illustrations) that
        // often don't map 1:1 to a DOM element at exact pixel coordinates
        const lowerName = name.toLowerCase();
        const isImageOrDecor = lowerName.includes('image') || lowerName.includes('img') ||
            lowerName.includes('photo') || lowerName.includes('icon') ||
            lowerName.includes('illustration') || lowerName.includes('logo') ||
            lowerName.includes('vector') || lowerName.includes('bitmap') ||
            lowerName.includes('mask') || lowerName.includes('clip') ||
            design.type === 'RECTANGLE' || design.type === 'ELLIPSE' ||
            design.type === 'VECTOR' || design.type === 'BOOLEAN_OPERATION' ||
            design.type === 'STAR' || design.type === 'LINE' ||
            design.type === 'POLYGON';
        
        const cx = (design.x || 0) + (design.w || 0) / 2;
        const cy = (design.y || 0) + (design.h || 0) / 2;
        
        if (cx <= 0 && cy <= 0) return;
        // Wider dedup radius (10px) to avoid checking overlapping tokens
        const posKey = Math.round(cx / 10) + ',' + Math.round(cy / 10);
        if (checkedPositions.has(posKey)) return;
        checkedPositions.add(posKey);
        
        // Multi-point probing: check center + 4 inner corners to avoid false negatives
        // from responsive shifts where the center pixel misses the element
        const probePoints = [
          [cx, cy],
          [(design.x || 0) + (design.w || 0) * 0.25, (design.y || 0) + (design.h || 0) * 0.25],
          [(design.x || 0) + (design.w || 0) * 0.75, (design.y || 0) + (design.h || 0) * 0.25],
          [(design.x || 0) + (design.w || 0) * 0.25, (design.y || 0) + (design.h || 0) * 0.75],
          [(design.x || 0) + (design.w || 0) * 0.75, (design.y || 0) + (design.h || 0) * 0.75],
        ];
        let el = null;
        for (const [px, py] of probePoints) {
          const probe = document.elementFromPoint(px, py);
          if (probe && probe !== document.body && probe !== document.documentElement) {
            el = probe; break;
          }
        }
        
        // === MISSING ELEMENT: Figma has content here but live page has nothing ===
        if (!el || el === document.body || el === document.documentElement) {
          // Skip image/decorative tokens — they cause false positives
          if (isImageOrDecor) return;
          // Only report if the Figma token is large enough to be a real component (not a spacer)
          if ((design.w || 0) > 50 && (design.h || 0) > 50) {
            const missingKey = `missing_${Math.round(cx / 20)}_${Math.round(cy / 20)}`;
            if (!seenElements.has(missingKey)) {
              seenElements.set(missingKey, results.length);
              tokenFailures++;
              results.push({
                type: 'LAYOUT_SHIFT',
                element: 'Missing Element',
                details: [`Element in Figma ("${name}") not found on live page at position (${Math.round(cx)}, ${Math.round(cy)}). Size: ${design.w}×${design.h}px`],
                rect: { x: Math.round(design.x || 0), y: Math.round(design.y || 0), w: Math.round(design.w || 50), h: Math.round(design.h || 50) }
              });
            }
          }
          return;
        }
        
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
        const role = design.role || 'leaf'; // text | container | leaf
        
        // Determine if this DOM element is a tangible interactive component
        const tangibleTags = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'LABEL'];
        const isTangible = tangibleTags.includes(tag) || el.getAttribute('role') === 'button';

        // ═══════════════════════════════════════
        // TEXT PROPERTIES (only for text tokens)
        // ═══════════════════════════════════════
        if (role === 'text' || design.fs) {
          if (design.fs && design.fs !== 'Mixed') {
            const liveSize = parseFloat(live.fontSize);
            const diff = Math.round(liveSize - design.fs);
            if (Math.abs(diff) > 2) errors.push('Font Size');
          }
          if (design.ff && design.ff !== 'Mixed' && live.fontFamily) {
            if (!live.fontFamily.toLowerCase().includes(design.ff.toLowerCase())) {
              errors.push('Font Family');
            }
          }
          if (design.fw && design.fw !== 'Mixed') {
            const weightMap = {
              'Thin': '100', 'Hairline': '100',
              'ExtraLight': '200', 'Extra Light': '200', 'UltraLight': '200', 'Ultra Light': '200',
              'Light': '300',
              'Regular': '400', 'Normal': '400', 'Book': '400',
              'Medium': '500',
              'SemiBold': '600', 'Semi Bold': '600', 'DemiBold': '600', 'Demi Bold': '600',
              'Bold': '700',
              'ExtraBold': '800', 'Extra Bold': '800', 'UltraBold': '800', 'Ultra Bold': '800',
              'Black': '900', 'Heavy': '900'
            };
            const expectedWeight = weightMap[design.fw] || design.fw;
            if (live.fontWeight !== expectedWeight && live.fontWeight !== String(expectedWeight)) {
              errors.push('Font Weight');
            }
          }
          if (design.color) {
            if (!colorsMatchBrowser(design.color, live.color)) {
              errors.push('Text Color');
            }
          }
          if (design.ls !== undefined && design.ls !== 'Mixed') {
            const liveLs = live.letterSpacing === 'normal' ? 0 : parseFloat(live.letterSpacing) || 0;
            const expectedLs = typeof design.ls === 'number' ? design.ls : 0;
            if (Math.abs(liveLs - expectedLs) > 2) errors.push('Letter Spacing');
          }
          if (design.lh !== undefined && design.lh !== 'Mixed') {
            const liveLh = live.lineHeight === 'normal' ? 0 : parseFloat(live.lineHeight) || 0;
            const expectedLh = typeof design.lh === 'number' ? design.lh : 0;
            if (expectedLh > 0 && liveLh > 0 && Math.abs(liveLh - expectedLh) > 2) {
              errors.push('Line Height');
            }
          }
          if (design.ta && design.ta !== 'Mixed') {
            const ta = design.ta.toLowerCase();
            const expected = ta === 'justified' ? 'justify' : ta;
            if (live.textAlign !== expected) errors.push('Text Align');
          }
          if (design.td && design.td !== 'Mixed') {
            const expected = design.td === 'strikethrough' ? 'line-through' : design.td;
            if (!live.textDecoration.includes(expected)) errors.push('Text Decoration');
          }
          if (design.tt && design.tt !== 'Mixed') {
            if (live.textTransform !== design.tt) errors.push('Text Transform');
          }
        }

        // ═══════════════════════════════════════
        // VISUAL PROPERTIES (containers + leaves)
        // ═══════════════════════════════════════
        if (role !== 'text') {
          if (design.bg && design.bg.length > 0) {
            const liveBg = parseColorBrowser(live.backgroundColor);
            if (liveBg && liveBg !== 'transparent' && liveBg !== 'rgba(0, 0, 0, 0)' && !colorsMatchBrowser(design.bg[0], live.backgroundColor)) {
              errors.push('Background Color');
            }
          }
          if (design.br !== undefined && design.br !== 'Mixed' && design.br > 0) {
            const liveRadius = parseFloat(live.borderRadius) || 0;
            const diff = Math.round(liveRadius - design.br);
            if (Math.abs(diff) > 2) errors.push('Border Radius');
          }
          if (design.op !== undefined && design.op < 1) {
            const liveOp = parseFloat(live.opacity);
            if (Math.abs(liveOp - design.op) > 0.05) errors.push('Opacity');
          }
          if (design.bw !== undefined && design.bw > 0) {
            const liveBw = parseFloat(live.borderWidth) || 0;
            if (Math.abs(liveBw - design.bw) > 2) errors.push('Border Width');
          }
          if (design.bc) {
            if (!colorsMatchBrowser(design.bc, live.borderColor)) {
              errors.push('Border Color');
            }
          }
        }

        // ═══════════════════════════════════════
        // SPACING PROPERTIES (containers only)
        // ═══════════════════════════════════════
        if (role === 'container' || design.pad || design.gap !== undefined) {
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
                if (Math.abs(diff) > 2) errors.push('Padding ' + s.name);
              }
            });
          }
          if (design.gap !== undefined) {
            const liveGap = live.gap === 'normal' ? 0 : parseFloat(live.gap) || 0;
            const diff = Math.round(liveGap - design.gap);
            if (Math.abs(diff) > 2) errors.push('Gap');
          }
        }

        // ═══════════════════════════════════════
        // DIMENSION PROPERTIES (tangible leaves ONLY)
        // ═══════════════════════════════════════
        if (role === 'leaf' && isTangible) {
          if (design.w !== undefined && design.w > 0) {
            const diffW = Math.round(rect.width - design.w);
            if (Math.abs(diffW) > 2) errors.push('Width');
          }
          if (design.h !== undefined && design.h > 0) {
            const diffH = Math.round(rect.height - design.h);
            if (Math.abs(diffH) > 2) errors.push('Height');
          }
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

          const layoutErrors = errors.filter(e => e === 'Width' || e === 'Height');
          const styleErrors = errors.filter(e => e !== 'Width' && e !== 'Height');
          
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

        // === NEW: FAIL FAST IF TOTAL MISMATCH ===
        if (pixelMatchPercent < 40) {
          console.error(`🚨 TOTAL MISMATCH DETECTED (${pixelMatchPercent}%). Aborting audit.`);
          const msg = "🚨 Whoops! This looks like a completely different page.";
          fs.writeFileSync('playwright-report/error-log.txt', msg);
          
          // Generate a "Failure PDF" so the user isn't stuck
          const failHtml = `<html><body style="font-family:sans-serif; text-align:center; padding:50px;">
            <h1 style="color:#ef4444; font-size:32px;">${msg}</h1>
            <p style="color:#64748b;">The live website does not visually resemble your Figma design. Match score: ${pixelMatchPercent}%</p>
          </body></html>`;
          const failPage = await browser.newPage();
          await failPage.setContent(failHtml);
          await failPage.pdf({ path: 'playwright-report/visual-audit-diff.pdf', format: 'A4' });
          
          process.exit(1);
        }

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

        // Filter out tiny boxes (noise)
        const rawClusters = clusters.filter(c => c !== null && c.w > 15 && c.h > 15);
        
        // === NEW: COMPONENT-BASED REFINEMENT ===
        // We take the raw pixel clusters and "snap" them to the nearest meaningful DOM component
        // This prevents 1440px wide boxes by ensuring the box doesn't grow larger than its DOM container.
        const finalClusters = await page.evaluate(async (raw) => {
          return raw.map(box => {
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            const el = document.elementFromPoint(cx, cy);
            if (!el || el === document.body || el === document.documentElement) return box;
            
            // Find the nearest semantic or meaningful container
            let container = el;
            const stopTags = ['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'MAIN'];
            while (container && container.parentElement && !stopTags.includes(container.tagName)) {
               // Don't let the box grow too large (cap at 80% screen width to prevent 1440px issue)
               if (container.offsetWidth > window.innerWidth * 0.8) break;
               container = container.parentElement;
            }
            
            if (!container) return box;
            const r = container.getBoundingClientRect();
            
            // If the DOM container is reasonably sized, use its bounds instead of raw pixel cluster
            if (r.width > 10 && r.height > 10 && r.width < window.innerWidth * 0.9) {
              return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
            }
            return box;
          });
        }, rawClusters);
        
        console.log(`📦 Grouped visual errors into ${finalClusters.length} component-based boxes.`);

        // Identify DOM element names for fallback
        const boxNames = await page.evaluate((boxes) => {
          return boxes.map(box => {
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            const el = document.elementFromPoint(cx, cy);
            if (!el) return 'Unknown Element';
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

        // --- SMART BOX ANALYSIS: identify DOM element + classify error type ---
        // AND call Gemini 3.1 Flash AI Vision for smart naming/fixes
        console.log('🤖 Calling Gemini 3.1 Flash-Lite for smart vision analysis...');
        
        for (let i = 0; i < finalClusters.length; i++) {
            const box = finalClusters[i];
            let elementLabel = boxNames[i];
            let aiFeedback = "Visual difference detected.";

            // 1. Capture AI-Vision Crop (Limit to first 5 for speed/free tier)
            if (i < 5) {
              try {
                const cropBuffer = await page.screenshot({ 
                  clip: { x: box.x, y: box.y, width: box.w, height: box.h },
                  type: 'png'
                });
                const base64 = cropBuffer.toString('base64');
                
                const visionRes = await fetch(`${WORKER_URL}/api/vision`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    image: base64,
                    prompt: "Analyze this UI component error. Respond in exactly this format: 'Name: [Component Name] | Fix: [Short 1-sentence fix]'."
                  })
                });
                
                if (visionRes.ok) {
                  const { analysis } = await visionRes.json();
                  if (analysis.includes('|')) {
                    const [name, fix] = analysis.split('|');
                    elementLabel = name.replace('Name:', '').trim();
                    aiFeedback = fix.replace('Fix:', '').trim();
                  } else {
                    aiFeedback = analysis;
                  }
                }
              } catch (aiErr) {
                console.warn('⚠️ AI Vision call failed for box', i, aiErr.message);
              }
            }

            visualIssues.push({
                type: 'MAJOR_VISUAL',
                element: elementLabel,
                details: [aiFeedback],
                rect: box
            });
        }


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
    
    // Sort issues top-to-bottom (by Y position), and left-to-right (by X position) for natural reading order
    allIssues.sort((a, b) => {
        if (Math.abs(a.rect.y - b.rect.y) > 10) return a.rect.y - b.rect.y;
        return a.rect.x - b.rect.x;
    });
    
    // Assign issue numbers sequentially (now in top-to-bottom order)
    allIssues.forEach((issue, index) => {
        issue.issueNum = index + 1;
    });

    // Use the REAL pixel-level match score for visual, and calculate token score for structure
    // Each checked token (represented by a result in tokenReport) checks around 5-8 properties.
    const validTokensCount = tokenReport.filter(r => r.type !== 'MAJOR_VISUAL' && r.element !== 'Missing Element').length;
    
    const visualMatchScore = pixelMatchPercent;
    let totalErrorsFound = 0;
    allIssues.forEach(i => {
        if (i.type !== 'MAJOR_VISUAL' && i.details) totalErrorsFound += i.details.length;
    });

    // Dynamically scale total rules evaluated to accurately reflect the volume of tokens vs volume of errors.
    const totalRulesChecked = Math.max(validTokensCount * 12, totalErrorsFound + Math.max(10, validTokensCount * 2));
    
    const trueMatchScore = totalRulesChecked > 0 
        ? Math.max(0, Math.round(((totalRulesChecked - totalErrorsFound) / totalRulesChecked) * 100))
        : 100;

    // === DYNAMIC MULTI-SCREENSHOT LOGIC ===
    const maxScreenshots = Math.min(3, Math.ceil(allIssues.length / 8));
    const issuesPerScreen = Math.ceil(allIssues.length / Math.max(1, maxScreenshots));
    console.log(`📸 Generating ${maxScreenshots} screenshot(s)...`);
    
    const screenshotPaths = [];
    for (let i = 0; i < maxScreenshots; i++) {
        await page.evaluate(() => {
          document.querySelectorAll('.audit-marker-box, .audit-marker-badge').forEach(el => el.remove());
        });

        const chunkStart = i * issuesPerScreen;
        const chunkEnd = i === maxScreenshots - 1 ? allIssues.length : chunkStart + issuesPerScreen;
        const issueChunk = allIssues.slice(chunkStart, chunkEnd);

        await page.evaluate((issues) => {
            const palette = ['#3B82F6', '#EC4899', '#F97316', '#10B981', '#8B5CF6', '#EF4444', '#14B8A6'];
            const placedBadges = [];

            issues.forEach(issue => {
                const color = palette[(issue.issueNum - 1) % palette.length];
                const bx = Math.max(0, issue.rect.x - 6);
                const by = Math.max(0, issue.rect.y - 6);
                const bw = issue.rect.w + 12;
                const bh = issue.rect.h + 12;

                // Draw a clean colored bounding box around the flagged component
                const box = document.createElement('div');
                box.className = 'audit-marker-box';
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                box.style.cssText = `position:absolute;z-index:10000;pointer-events:none;top:${by}px;left:${bx}px;width:${bw}px;height:${bh}px;border:3px solid ${color};background:rgba(${r},${g},${b},0.12);border-radius:4px;`;
                document.body.appendChild(box);

                let badgeX = bx - 14;
                let badgeY = by - 14;

                // Edge safety
                badgeX = Math.max(10, badgeX);
                badgeY = Math.max(10, badgeY);

                // Collision Detection
                const badgeWidth = 28;
                const badgeHeight = 28;
                const MARGIN = 4;
                let hasCollision = true;
                while (hasCollision) {
                    hasCollision = false;
                    for (const placed of placedBadges) {
                        if (
                            badgeX < placed.x + badgeWidth + MARGIN &&
                            badgeX + badgeWidth + MARGIN > placed.x &&
                            badgeY < placed.y + badgeHeight + MARGIN &&
                            badgeY + badgeHeight + MARGIN > placed.y
                        ) {
                            badgeX = placed.x + badgeWidth + MARGIN;
                            hasCollision = true;
                            if (badgeX > window.innerWidth - 40) {
                                badgeX = bx - 14; 
                                badgeY += badgeHeight + MARGIN; 
                            }
                            break;
                        }
                    }
                }
                placedBadges.push({ x: badgeX, y: badgeY });

                // Issue number badge (circle)
                const numBadge = document.createElement('div');
                numBadge.className = 'audit-marker-badge';
                numBadge.textContent = String(issue.issueNum);
                numBadge.style.cssText = `position:absolute;z-index:10001;pointer-events:none;top:${badgeY}px;left:${badgeX}px;min-width:28px;height:28px;padding:0 6px;background:${color};color:white;border-radius:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.4);border:2px solid #fff;`;
                document.body.appendChild(numBadge);
            });
        }, issueChunk);

        const path = `playwright-report/screenshot-chunk-${i+1}.png`;
        await page.screenshot({ path, fullPage: true });
        const buffer = fs.readFileSync(path);
        screenshotPaths.push(buffer.toString('base64'));
    }

    const screenshotHtmlChunks = screenshotPaths.map((base64, idx) => `
      <div class="screenshot-section" style="padding:32px 48px;${idx > 0 ? 'page-break-before:always;' : ''}">
        <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">📸 Audit View ${idx + 1} of ${maxScreenshots}</h2>
        <div style="padding:12px;background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,0.1);border:1px solid #e2e8f0;text-align:center;">
          <img src="data:image/png;base64,${base64}" style="max-width:750px;width:100%;height:auto;display:inline-block;border-radius:8px;max-height:950px;object-fit:contain;" />
        </div>
      </div>
    `).join('');

    const auditDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // 3. Build Issue HTML List
    const palette = ['#3B82F6', '#EC4899', '#F97316', '#10B981', '#8B5CF6', '#EF4444', '#14B8A6'];
    const issueRows = allIssues.map((issue) => {
      const color = palette[(issue.issueNum - 1) % palette.length];
      const detailRows = issue.details.map(d => {
        const parts = d.split(':');
        // Handle legacy formatted strings or our new simple hints
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join(':').trim();
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#475569;width:100%;">
            <span style="font-weight:600;color:#0f1b35;">${key}</span>
            <span style="text-align:right;background:#f8fafc;padding:4px 8px;border-radius:6px;border:1px solid #e2e8f0;font-family:monospace;letter-spacing:-0.2px;">${val}</span>
          </div>`;
        }
        // New compact inline tag style for simple hints
        // We use a light, subtle background based on an alpha version of the primary color or a neutral tone
        return `<span style="display:inline-block;background:#f8fafc;border:1px solid #e2e8f0;padding:4px 10px;border-radius:12px;font-size:13px;color:#334155;font-weight:500;">${d}</span>`;
      }).join('');
      
      // If we have legacy rows, we wrap them normally, but for our inline tags we use a flex gap layout
      const hasLegacyRows = issue.details.some(d => d.includes(':'));
      const detailsContainerStyle = hasLegacyRows 
        ? `display:flex;flex-direction:column;`
        : `display:flex;flex-wrap:wrap;gap:8px;margin-top:2px;`;

      return `
      <div class="issue-card" style="display:flex;gap:12px;padding:14px;margin:0 0 10px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.1);border-left:4px solid ${color};break-inside:avoid;page-break-inside:avoid;">
        <div style="min-width:28px;height:28px;background:${color};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">${issue.issueNum}</div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:15px;color:#0f1b35;margin-bottom:8px;line-height:1.2;">${issue.element}</div>
          <div style="${detailsContainerStyle}">${detailRows}</div>
        </div>
      </div>`;
    }).join('');

    // 4. Build Final Output HTML
    const reportHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  @media print {
    .screenshot-section { page-break-before: always; page-break-inside: avoid; }
    .issue-card { break-inside: avoid; page-break-inside: avoid; }
    img { max-height: 950px; object-fit: contain; }
  }
  .screenshot-section { page-break-inside: avoid; }
  .issue-card { break-inside: avoid; page-break-inside: avoid; }
</style>
</head>
<body style="margin:0;font-family:sans-serif;background:#f1f5f9;">
  <div style="background:linear-gradient(135deg,#0f5ec4 0%,#3da5ff 100%);padding:40px 48px;color:#fff;">
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">
      <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px;">UI Match</div>
      <div style="font-size:13px;opacity:0.7;border-left:2px solid rgba(255,255,255,0.3);padding-left:16px;">Visual Audit Report</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;opacity:0.9;">
      <div>🎨 <strong>Figma Frame:</strong> ${frameName}</div>
      
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="flex:1;word-break:break-all;padding-right:24px;">🌍 <strong>Website:</strong> ${targetUrl}</div>
        <div style="white-space:nowrap;">📅 <strong>Date:</strong> ${auditDate}</div>
      </div>

      <div>📐 <strong>Viewport:</strong> 1440&times;900px</div>
    </div>
    <div style="display:flex;gap:16px;margin-top:24px;">
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;">
        <div style="font-size:28px;font-weight:800;">${trueMatchScore}%</div>
        <div style="font-size:11px;">Token Match Score</div>
      </div>
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;">
        <div style="font-size:28px;font-weight:800;">${visualMatchScore}%</div>
        <div style="font-size:11px;">Visual Match Score</div>
      </div>
      <div style="background:rgba(255,255,255,0.15);padding:14px 22px;border-radius:12px;text-align:center;">
        <div style="font-size:28px;font-weight:800;">${allIssues.length}</div>
        <div style="font-size:11px;">Issues Found</div>
      </div>
    </div>
  </div>
  ${screenshotHtmlChunks}

  <div style="padding:0 48px 48px;">
    <h2 style="font-size:17px;color:#0f1b35;margin:0 0 16px;">🔍 Issue Log</h2>
    ${issueRows || '<p>✅ Perfect Match!</p>'}
  </div>
</body></html>`;

    // 5. Render final PDF report
    const reportPage = await browser.newPage();
    await reportPage.setContent(reportHtml, { waitUntil: 'load' });
    await reportPage.pdf({ path: 'playwright-report/visual-audit-diff.pdf', format: 'A4', printBackground: true, margin: { top: '24px', bottom: '24px', left: '24px', right: '24px' } });
    await reportPage.screenshot({ path: 'playwright-report/visual-audit-diff.png', fullPage: true });

    await reportPage.close();
    console.log('📸 Visual report saved as visual-audit-diff.pdf + .png');

    const finalResults = {
      trueMatchScore,
      visualMatchScore,
      totalIssues: allIssues.length,
      tokens: tokenReport
    };
    fs.writeFileSync('playwright-report/audit-results.json', JSON.stringify(finalResults, null, 2));
    console.log(`✅ Audit completed. True: ${trueMatchScore}%, Visual: ${visualMatchScore}%. ${allIssues.length} total issues found.`);

  } catch (error) {
    console.error('❌ Audit failed:', error);
    if (error.message && error.message.includes('Abort')) {
      fs.writeFileSync('playwright-report/error-log.txt', error.message);
    } else {
      fs.writeFileSync('playwright-report/error-log.txt', `Crash Report:\n${error.stack}`);
    }
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

runAudit();
