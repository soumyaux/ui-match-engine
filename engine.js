const { chromium } = require('playwright');
const fs = require('fs');

// Single source of truth for issue highlight colors.
// Used in BOTH screenshot overlay and PDF issue cards so numbers always match colors.
const ISSUE_PALETTE = ['#3B82F6', '#EC4899', '#F97316', '#10B981', '#8B5CF6', '#EF4444', '#14B8A6'];

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

    // Detect if the site uses a responsive viewport meta tag.
    // If Figma frame width ≠ standard desktop (1440px), there may be
    // scaling differences between the design and what we render.
    const isResponsive = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return !!(meta && meta.content && meta.content.includes('width=device-width'));
    });
    if (isResponsive && frameWidth !== 1440) {
      console.log(`⚠️ Responsive site detected at non-standard width (${frameWidth}px). Some spacing/text differences may be due to responsive scaling.`);
    }
    
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


    // 4. Multi-pass scroll to trigger all lazy-loaded content (images, deferred components)
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight / 3)));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, Math.floor((document.body.scrollHeight * 2) / 3)));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    console.log('✅ Environment normalized — fonts loaded, animations frozen, dynamic content hidden.');

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
        // Only skip if the layer name indicates a decorative element, OR if it is a pure geometry type.
        // RECTANGLEs and ELLIPSEs that represent real UI components (buttons, cards) are kept.
        const lowerName = name.toLowerCase();
        const hasDecorativeName = lowerName.includes('image') || lowerName.includes('img') ||
            lowerName.includes('photo') || lowerName.includes('icon') ||
            lowerName.includes('illustration') || lowerName.includes('logo') ||
            lowerName.includes('vector') || lowerName.includes('bitmap') ||
            lowerName.includes('mask') || lowerName.includes('clip') ||
            lowerName.includes('divider') || lowerName.includes('separator') ||
            lowerName === 'bg' || lowerName.endsWith(' bg') || lowerName.startsWith('bg ') ||
            lowerName.includes('background') || lowerName.includes('decor');
        const isPureShape = design.type === 'VECTOR' || design.type === 'BOOLEAN_OPERATION' ||
            design.type === 'STAR' || design.type === 'LINE' || design.type === 'POLYGON';
        // RECTANGLE/ELLIPSE only treated as decorative when ALSO named as decorative
        const isImageOrDecor = hasDecorativeName || isPureShape ||
            ((design.type === 'RECTANGLE' || design.type === 'ELLIPSE') && hasDecorativeName);
        
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
        // Skip media/image/chart elements — these are dynamic content that always differs from Figma
        const tag = el.tagName.toUpperCase();
        if (tag === 'IMG' || tag === 'PICTURE' || tag === 'CANVAS' || tag === 'IFRAME' || tag === 'VIDEO' || tag === 'AUDIO') return;
        if (tag === 'SVG' || el.closest?.('svg')) return;
        if (el.closest?.('canvas') || el.closest?.('iframe') || el.closest?.('picture')) return;
        // Skip elements with background-image (hero banners, card thumbnails, etc.)
        const computedBg = window.getComputedStyle(el).backgroundImage;
        if (computedBg && computedBg !== 'none' && computedBg.includes('url(')) return;
        // Skip elements inside image/media containers
        if (el.closest?.('figure') || el.closest?.('[class*="image"]') || el.closest?.('[class*="Image"]')) return;
        // Skip elements inside chart containers (common libraries)
        if (el.closest?.('[class*="chart"]') || el.closest?.('[class*="graph"]') || el.closest?.('[class*="recharts"]') || el.closest?.('[class*="highcharts"]') || el.closest?.('[class*="apexcharts"]')) return;

        // Skip generic full-page wrapper divs that are just layout containers
        // These are wrappers like div.size-full, div#root, div#app, div#__next
        // They cover the entire viewport and have no meaningful design properties
        const rect = el.getBoundingClientRect();
        if (tag === 'DIV') {
          const cls = (el.className || '').toString().toLowerCase();
          const elId = (el.id || '').toLowerCase();
          const isFullPageWrapper = (rect.width >= window.innerWidth * 0.95 && rect.height >= window.innerHeight * 0.9);
          const isKnownWrapper = cls.includes('size-full') || cls.includes('app') || cls.includes('root') || cls.includes('wrapper') || cls.includes('container') || cls.includes('layout') || elId === 'root' || elId === 'app' || elId === '__next' || elId === '__nuxt';
          if (isFullPageWrapper || isKnownWrapper) return;
        }

        const live = window.getComputedStyle(el);
        // Skip off-screen or invisible elements
        if (rect.width < 5 || rect.height < 5) return;
        // Skip hidden elements (display:none, visibility:hidden, opacity:0)
        if (live.display === 'none' || live.visibility === 'hidden' || live.opacity === '0') return;
        // Skip elements positioned way outside the viewport (off-screen tricks)
        if (rect.right < 0 || rect.bottom < 0) return;
        // Use Figma layer name for issue titles — much more useful for designers
        // Clean it: take last segment of path (e.g., "Frame / Section / Button" → "Button")
        const figmaName = name && name !== 'unknown' ? name.split('/').pop().trim() : null;
        const elName = figmaName || getElementName(el);
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
              rect: { x: Math.round(rect.left + (window.scrollX || 0) || design.x || 0), y: Math.round(rect.top + (window.scrollY || 0) || design.y || 0), w: Math.round(rect.width || design.w || 50), h: Math.round(rect.height || design.h || 50) }
            });
          }
          if (styleErrors.length > 0) {
            const idx = results.length;
            if (!seenElements.has(elKey)) seenElements.set(elKey, idx);
            results.push({
              type: 'MINOR_DIFF',
              element: elName,
              details: styleErrors,
              rect: { x: Math.round(rect.left + (window.scrollX || 0) || design.x || 0), y: Math.round(rect.top + (window.scrollY || 0) || design.y || 0), w: Math.round(rect.width || design.w || 50), h: Math.round(rect.height || design.h || 50) }
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
    
    // Apply image blackout for pixelmatch comparison (prevents false mismatches from image content)
    await page.addStyleTag({ content: `
      img, picture, video, canvas, svg:not(.audit-svg), [style*="background-image"] {
        filter: brightness(0) !important;
        background: #000 !important;
        color: transparent !important;
      }
    `});
    await page.waitForTimeout(200);
    
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

        // === FILTER: Remove clusters that overlap image/media areas ===
        // Check multiple probe points + child elements to catch image containers
        const nonImageClusters = await page.evaluate((boxes) => {
          return boxes.filter(box => {
            // Probe 5 points across the box (center + 4 corners)
            const probes = [
              [box.x + box.w / 2, box.y + box.h / 2],
              [box.x + box.w * 0.2, box.y + box.h * 0.2],
              [box.x + box.w * 0.8, box.y + box.h * 0.2],
              [box.x + box.w * 0.2, box.y + box.h * 0.8],
              [box.x + box.w * 0.8, box.y + box.h * 0.8],
            ];
            let imageHits = 0;
            for (const [px, py] of probes) {
              const el = document.elementFromPoint(px, py);
              if (!el) continue;
              const tag = el.tagName.toUpperCase();
              if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE') imageHits++;
              if (tag === 'SVG' || el.closest?.('svg')) imageHits++;
              const style = window.getComputedStyle(el);
              if (style.backgroundImage && style.backgroundImage !== 'none' && style.backgroundImage.includes('url(')) imageHits++;
              if (el.closest?.('figure') || el.closest?.('[class*="image"]') || el.closest?.('[class*="Image"]')) imageHits++;
            }
            // If 2+ probe points hit image/media areas, skip this box
            if (imageHits >= 2) return false;
            
            // Also check if the box area CONTAINS image elements
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            const el = document.elementFromPoint(cx, cy);
            if (el) {
              const parent = el.closest('section, div, article, main') || el.parentElement;
              if (parent) {
                const imgs = parent.querySelectorAll('img, video, canvas, picture');
                const parentRect = parent.getBoundingClientRect();
                // If container has images and the box covers most of it, it's an image section
                if (imgs.length > 0 && parentRect.width > 0) {
                  const overlapW = Math.min(box.x + box.w, parentRect.right) - Math.max(box.x, parentRect.left);
                  const overlapH = Math.min(box.y + box.h, parentRect.bottom) - Math.max(box.y, parentRect.top);
                  if (overlapW > 0 && overlapH > 0) {
                    const overlapArea = overlapW * overlapH;
                    const boxArea = box.w * box.h;
                    if (boxArea > 0 && overlapArea / boxArea > 0.4) return false;
                  }
                }
              }
            }
            return true;
          });
        }, rawClusters);
        
        // === COMPONENT-BASED REFINEMENT ===
        // Snap clusters to nearest DOM component, but don't let the box grow too large
        const finalClusters = await page.evaluate(async (raw) => {
          return raw.filter(box => {
            // Cap: skip boxes larger than 50% viewport width or 400px tall
            if (box.w > window.innerWidth * 0.5 || box.h > 400) return false;
            return true;
          }).map(box => {
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            const el = document.elementFromPoint(cx, cy);
            if (!el || el === document.body || el === document.documentElement) return box;
            
            // Find the nearest meaningful container
            let container = el;
            const stopTags = ['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'MAIN'];
            while (container && container.parentElement && !stopTags.includes(container.tagName)) {
               if (container.offsetWidth > window.innerWidth * 0.5) break;
               container = container.parentElement;
            }
            
            if (!container) return box;
            const r = container.getBoundingClientRect();
            
            // Only snap if the container isn't much bigger than the original cluster (max 2x)
            if (r.width > 10 && r.height > 10 && r.width < window.innerWidth * 0.5 &&
                r.width <= box.w * 2.5 && r.height <= box.h * 2.5) {
              return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
            }
            return box;
          });
        }, nonImageClusters);
        
        // === MATCH FROM FIGMA TO LIVE: IoU-based filtering ===
        // For each visual cluster, find the best-overlapping LEAF Figma token.
        // Only keep clusters that genuinely correspond to a Figma element.
        // Use the Figma token name as the issue label (not DOM names like "div.flex").
        const figmaMatchedClusters = [];
        const figmaMatchedNames = [];
        
        for (const box of finalClusters) {
          let bestToken = null;
          let bestIoU = 0;

          for (const token of designTokens) {
            // Skip container tokens — they cover entire sections and match everything
            if (token.role === 'container') continue;
            // Skip tiny spacers
            if ((token.w || 0) < 15 && (token.h || 0) < 15) continue;
            // Skip purely decorative shape tokens — visual diffs on decorative fills are noise
            const tName = (token.name || '').toLowerCase();
            const tIsDecor = tName.includes('image') || tName.includes('img') || tName.includes('icon') ||
                tName.includes('logo') || tName.includes('photo') || tName.includes('illustration') ||
                tName === 'bg' || tName.endsWith(' bg') || tName.startsWith('bg ') ||
                tName.includes('background') || tName.includes('divider') || tName.includes('separator') ||
                token.type === 'VECTOR' || token.type === 'BOOLEAN_OPERATION' ||
                token.type === 'STAR' || token.type === 'LINE' || token.type === 'POLYGON' ||
                ((token.type === 'RECTANGLE' || token.type === 'ELLIPSE') &&
                 (tName.includes('bg') || tName.includes('background') || tName.includes('decor') ||
                  tName.includes('fill') || tName.includes('shape')));
            if (tIsDecor) continue;
            
            const tx = token.x || 0, ty = token.y || 0;
            const tw = token.w || 0, th = token.h || 0;
            
            // Calculate intersection
            const ix1 = Math.max(box.x, tx);
            const iy1 = Math.max(box.y, ty);
            const ix2 = Math.min(box.x + box.w, tx + tw);
            const iy2 = Math.min(box.y + box.h, ty + th);
            
            if (ix2 <= ix1 || iy2 <= iy1) continue; // No intersection
            
            const interArea = (ix2 - ix1) * (iy2 - iy1);
            const boxArea = box.w * box.h;
            const tokenArea = tw * th;
            const unionArea = boxArea + tokenArea - interArea;
            
            if (unionArea <= 0) continue;
            const iou = interArea / unionArea;
            
            if (iou > bestIoU) {
              bestIoU = iou;
              bestToken = token;
            }
          }
          
          // Require meaningful overlap to consider it a real match.
          // EITHER high IoU (>0.25) OR moderate IoU where cluster center falls inside the token.
          // This prevents live-only elements (cookie banners, sticky headers) from being
          // falsely attributed to nearby Figma tokens via low-overlap matches.
          const clusterCX = box.x + box.w / 2;
          const clusterCY = box.y + box.h / 2;
          const bestTx = bestToken ? (bestToken.x || 0) : 0;
          const bestTy = bestToken ? (bestToken.y || 0) : 0;
          const bestTw = bestToken ? (bestToken.w || 0) : 0;
          const bestTh = bestToken ? (bestToken.h || 0) : 0;
          const centerInToken = clusterCX >= bestTx && clusterCX <= bestTx + bestTw &&
                                clusterCY >= bestTy && clusterCY <= bestTy + bestTh;
          if (bestToken && (bestIoU > 0.25 || (bestIoU > 0.08 && centerInToken))) {
            figmaMatchedClusters.push(box);
            // Use the Figma layer name (last path segment)
            const rawName = bestToken.name || 'unknown';
            const cleanName = rawName.split('/').pop().trim();
            figmaMatchedNames.push(cleanName !== 'unknown' ? cleanName : 'Component');
          }
        }

        console.log(`📦 Matched ${figmaMatchedClusters.length} visual clusters to Figma tokens (from ${finalClusters.length} candidates).`);

        // --- SMART BOX ANALYSIS: identify DOM element + classify error type ---
        // Capture crops for first 5 issues in parallel, then call Gemini in parallel.
        console.log('🤖 Calling AI Vision for smart visual analysis (parallel)...');

        const AI_LIMIT = Math.min(5, figmaMatchedClusters.length);

        // Capture all crops concurrently
        const cropBase64s = await Promise.all(
          figmaMatchedClusters.slice(0, AI_LIMIT).map(box =>
            page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h }, type: 'png' })
              .then(buf => buf.toString('base64'))
              .catch(() => null)
          )
        );

        // Call Gemini Vision for all crops in parallel
        const aiResults = await Promise.all(
          cropBase64s.map((base64, i) => {
            if (!base64) return Promise.resolve({ label: figmaMatchedNames[i], feedback: 'Visual difference detected.' });
            return fetch(`${WORKER_URL}/api/vision`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                image: base64,
                prompt: "Analyze this UI component error. Respond in exactly this format: 'Name: [Component Name] | Fix: [Short 1-sentence fix]'."
              })
            })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              const analysis = data?.analysis || '';
              if (analysis && !analysis.toLowerCase().includes('failed') && analysis.includes('|')) {
                const [name, fix] = analysis.split('|');
                return { label: name.replace('Name:', '').trim(), feedback: fix.replace('Fix:', '').trim() };
              }
              return { label: figmaMatchedNames[i], feedback: analysis || 'Visual difference detected.' };
            })
            .catch(() => ({ label: figmaMatchedNames[i], feedback: 'Visual difference detected.' }));
          })
        );

        for (let i = 0; i < figmaMatchedClusters.length; i++) {
            const ai = aiResults[i] || { label: figmaMatchedNames[i], feedback: 'Visual difference detected.' };
            visualIssues.push({
                type: 'MAJOR_VISUAL',
                element: ai.label,
                details: [ai.feedback],
                rect: figmaMatchedClusters[i]
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

    // --- MATHEMATICAL MISMATCH FAST-FAIL ---
    // If < 15% Match Score, the layout structure completely deviates from the Figma Tokens.
    // Throws a clean mismatch instead of generating a messy 0% PDF.
    if (trueMatchScore < 15) {
      console.log('❌ MATHEMATICAL MISMATCH: Final engine match score is less than 15%. This URL completely deviates from the Figma design.');
      
      // Write error log so the Github Action catches it and updates Supabase to 'failed' reliably
      fs.writeFileSync('playwright-report/error-log.txt', 'Layout Mismatch: The provided website structure completely deviates from the Figma design. Please check the URL and try again.');
      
      // Exit with error code 1 so the Action drops into the 'failure()' block
      process.exit(1);
    }

    // ══════════════════════════════════════════
    // PHASE 4: RESPONSIVE BREAKPOINT CHECK
    // ══════════════════════════════════════════
    // Re-render at common breakpoints (only those narrower than the Figma frame)
    // and check for real breakage: overflow, off-screen elements, text clipping.
    console.log('📱 Running responsive breakpoint checks...');

    const ALL_BREAKPOINTS = [
      { width: 375, label: 'Mobile (375px)' },
    ];
    const activeBreakpoints = ALL_BREAKPOINTS.filter(bp => bp.width < frameWidth);
    const responsiveIssuesByBreakpoint = [];

    // Collect leaf tokens for position probing (skip containers and tiny spacers)
    const leafTokens = designTokens.filter(t =>
      t.role !== 'container' && (t.w || 0) >= 30 && (t.h || 0) >= 20
    ).slice(0, 40); // cap at 40 to keep this fast

    for (const bp of activeBreakpoints) {
      await page.setViewportSize({ width: bp.width, height: 900 });
      await page.waitForTimeout(300);

      const bpIssues = await page.evaluate(({ tokens, bpWidth }) => {
        const issues = [];

        // 1. Horizontal overflow — the most common responsive bug
        const scrollW = document.documentElement.scrollWidth;
        const clientW = document.documentElement.clientWidth;
        if (scrollW > clientW + 5) {
          issues.push({
            issueType: 'overflow',
            label: 'Page has horizontal overflow',
            detail: `Page content (${scrollW}px) is wider than the ${bpWidth}px viewport. Users will need to scroll sideways.`
          });
        }

        // 2. Per-token checks
        for (const token of tokens) {
          const tokenName = (token.name || 'unknown').split('/').pop().trim();
          // Clamp x to stay inside the narrower viewport
          const cx = Math.min((token.x || 0) + (token.w || 0) / 2, bpWidth - 10);
          const cy = (token.y || 0) + (token.h || 0) / 2;

          const el = document.elementFromPoint(cx, cy);
          if (!el || el === document.body || el === document.documentElement) continue;

          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const tag = el.tagName.toUpperCase();

          // Skip media elements — they legitimately change size
          if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'SVG') continue;
          if (el.closest?.('svg')) continue;

          // 2a. Element is entirely off-screen to the right
          if (rect.left > bpWidth + 10) {
            issues.push({
              issueType: 'offscreen',
              label: `"${tokenName}" is off-screen`,
              detail: `Element starts at ${Math.round(rect.left)}px — outside the ${bpWidth}px viewport.`
            });
            continue;
          }

          // 2b. Element content overflows its own box
          if (el.scrollWidth > el.clientWidth + 8 && el.clientWidth > 0) {
            issues.push({
              issueType: 'overflow',
              label: `"${tokenName}" content overflows`,
              detail: `Element is ${el.clientWidth}px wide but its content is ${el.scrollWidth}px. Text or children are spilling out.`
            });
          }

          // 2c. Text is visually clipped (hidden overflow + content taller than box)
          if ((style.overflow === 'hidden' || style.overflow === 'clip') &&
              el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 0) {
            issues.push({
              issueType: 'clipped',
              label: `"${tokenName}" text is clipped`,
              detail: `Content height is ${el.scrollHeight}px but box is only ${el.clientHeight}px. Text is being cut off.`
            });
          }

          // 2d. Element overlaps its sibling (crude overlap detection)
          const nextSibling = el.nextElementSibling;
          if (nextSibling) {
            const sibRect = nextSibling.getBoundingClientRect();
            if (rect.bottom > sibRect.top + 10 && rect.right > sibRect.left + 10 &&
                rect.left < sibRect.right && rect.top < sibRect.bottom) {
              issues.push({
                issueType: 'overlap',
                label: `"${tokenName}" overlaps next element`,
                detail: `At ${bpWidth}px, this element visually overlaps its sibling — likely a missing responsive rule.`
              });
            }
          }
        }

        // Deduplicate by label
        const seen = new Set();
        return issues.filter(i => {
          if (seen.has(i.label)) return false;
          seen.add(i.label);
          return true;
        });
      }, { tokens: leafTokens, bpWidth: bp.width });

      if (bpIssues.length > 0) {
        responsiveIssuesByBreakpoint.push({ label: bp.label, width: bp.width, issues: bpIssues });
        console.log(`  📱 ${bp.label}: ${bpIssues.length} issue(s)`);
      } else {
        console.log(`  ✅ ${bp.label}: No issues`);
      }
    }

    // Restore original viewport before screenshots
    await page.setViewportSize({ width: frameWidth, height: frameHeight });
    await page.waitForTimeout(300);
    console.log(`📱 Responsive check done: ${responsiveIssuesByBreakpoint.reduce((s, b) => s + b.issues.length, 0)} total responsive issues.`);

    // === DYNAMIC MULTI-SCREENSHOT LOGIC ===
    // Remove the image blackout so PDF screenshots show real website images
    await page.evaluate(() => {
      // Remove the blackout style tag
      const blackoutStyles = document.querySelectorAll('style');
      blackoutStyles.forEach(s => {
        if (s.textContent.includes('brightness(0)')) s.remove();
      });
    });
    await page.waitForTimeout(200);
    
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

        await page.evaluate(({ issues, palette }) => {
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
        }, { issues: issueChunk, palette: ISSUE_PALETTE });

        const path = `playwright-report/screenshot-chunk-${i+1}.png`;
        // Full-page screenshot: capture from y=0 to bottom of last issue (+ padding)
        // Always starts at top so user sees the full website context, not a tiny crop
        const contentBounds = await page.evaluate((chunk) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const sw = document.body.scrollWidth || vw;
          if (!chunk || chunk.length === 0) return { width: Math.max(vw, sw), height: vh };
          
          let maxY = 0;
          let maxX = 0;
          for (const issue of chunk) {
            const bottom = (issue.rect?.y || 0) + (issue.rect?.h || 0) + 80;
            const right = (issue.rect?.x || 0) + (issue.rect?.w || 0) + 40;
            if (bottom > maxY) maxY = bottom;
            if (right > maxX) maxX = right;
          }
          
          // Use full scrollable width to prevent content clipping
          const cropWidth = Math.max(vw, sw, maxX);
          const cropHeight = Math.max(vh, maxY);
          return { width: Math.min(cropWidth, 3000), height: Math.min(cropHeight, 5000) };
        }, issueChunk);
        
        await page.screenshot({ path, fullPage: true, clip: { x: 0, y: 0, width: contentBounds.width, height: contentBounds.height } });
        const buffer = fs.readFileSync(path);
        screenshotPaths.push(buffer.toString('base64'));
    }

    const auditDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // 3. Build paired Audit View + Issue blocks
    
    function buildIssueCard(issue) {
      const color = ISSUE_PALETTE[(issue.issueNum - 1) % ISSUE_PALETTE.length];
      const detailRows = issue.details.map(d => {
        const parts = d.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join(':').trim();
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#475569;width:100%;">
            <span style="font-weight:600;color:#0f1b35;">${key}</span>
            <span style="text-align:right;background:#f8fafc;padding:4px 8px;border-radius:6px;border:1px solid #e2e8f0;font-family:monospace;letter-spacing:-0.2px;">${val}</span>
          </div>`;
        }
        return `<span style="display:inline-block;background:#f8fafc;border:1px solid #e2e8f0;padding:4px 10px;border-radius:12px;font-size:13px;color:#334155;font-weight:500;">${d}</span>`;
      }).join('');
      
      const hasLegacyRows = issue.details.some(d => d.includes(':'));
      const detailsStyle = hasLegacyRows 
        ? `display:flex;flex-direction:column;`
        : `display:flex;flex-wrap:wrap;gap:8px;margin-top:2px;`;

      return `
      <div class="issue-card" style="display:flex;gap:12px;padding:14px;margin:0 0 10px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.1);border-left:4px solid ${color};break-inside:avoid;page-break-inside:avoid;">
        <div style="min-width:28px;height:28px;background:${color};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">${issue.issueNum}</div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:15px;color:#0f1b35;margin-bottom:8px;line-height:1.2;">${issue.element}</div>
          <div style="${detailsStyle}">${detailRows}</div>
        </div>
      </div>`;
    }

    // Build each section: Screenshot → Its Issues
    const auditSections = screenshotPaths.map((base64, idx) => {
      const chunkStart = idx * issuesPerScreen;
      const chunkEnd = idx === maxScreenshots - 1 ? allIssues.length : chunkStart + issuesPerScreen;
      const chunkIssues = allIssues.slice(chunkStart, chunkEnd);
      const issueCards = chunkIssues.map(buildIssueCard).join('');
      
      return `
      <div style="padding:16px 24px 8px;">
        <h2 style="font-size:15px;color:#0f1b35;margin:0 0 10px;">📸 Audit View ${idx + 1} of ${maxScreenshots} <span style="font-size:12px;color:#64748b;font-weight:400;">— ${chunkIssues.length} issue${chunkIssues.length !== 1 ? 's' : ''}</span></h2>
        <div style="border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,0.08);border:1px solid #e2e8f0;overflow:hidden;">
          <img src="data:image/png;base64,${base64}" style="width:100%;height:auto;display:block;object-fit:contain;" />
        </div>
      </div>
      <div style="padding:8px 24px 16px;">
        <h3 style="font-size:13px;color:#64748b;margin:0 0 10px;font-weight:600;">Issues ${chunkIssues.length > 0 ? chunkIssues[0].issueNum + '–' + chunkIssues[chunkIssues.length-1].issueNum : ''} · Figma Frame: ${frameName}</h3>
        ${issueCards || '<p style="color:#10b981;font-size:14px;">✅ No issues in this view</p>'}
      </div>`;
    }).join('');

    // 4. Build Final Output HTML
    const reportHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  .issue-card { break-inside: avoid; page-break-inside: avoid; }
</style>
</head>
<body style="margin:0;font-family:sans-serif;background:#ffffff;">
  <div style="background:linear-gradient(135deg,#0f5ec4 0%,#3da5ff 100%);padding:24px 24px 20px;color:#fff;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <div style="font-size:28px;font-weight:800;letter-spacing:-0.5px;">UI Match</div>
      <div style="font-size:13px;opacity:0.7;border-left:2px solid rgba(255,255,255,0.3);padding-left:16px;">Visual Audit Report</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;opacity:0.9;">
      <div>🎨 <strong>Figma Frame:</strong> ${frameName}</div>
      
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="flex:1;word-break:break-all;padding-right:24px;">🌍 <strong>Website:</strong> ${targetUrl}</div>
        <div style="white-space:nowrap;">📅 <strong>Date:</strong> ${auditDate}</div>
      </div>

      <div>📐 <strong>Viewport:</strong> ${frameWidth}&times;${frameHeight}px${isResponsive ? ` <span style="background:rgba(255,200,0,0.25);color:#fff;padding:2px 10px;border-radius:4px;font-size:11px;margin-left:8px;border:1px solid rgba(255,255,255,0.3);">⚠️ Responsive site — audit at Figma frame width (${frameWidth}px). If your Figma frame is 1920px but site renders at 1440px, text/gap values may differ by design.</span>` : ''}</div>
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
  ${auditSections}
  ${responsiveIssuesByBreakpoint.length > 0 ? `
  <div style="padding:16px 24px 8px;">
    <h2 style="font-size:15px;color:#0f1b35;margin:0 0 4px;">📱 Responsive Breakpoint Check</h2>
    <p style="font-size:12px;color:#64748b;margin:0 0 12px;">Issues found when the page is resized to smaller viewports.</p>
    ${responsiveIssuesByBreakpoint.map(bp => `
      <div style="margin-bottom:14px;">
        <div style="font-size:13px;font-weight:700;color:#0f1b35;margin-bottom:8px;padding:6px 12px;background:#f1f5f9;border-radius:6px;">
          ${bp.label}
          <span style="font-weight:400;color:#64748b;margin-left:8px;">${bp.issues.length} issue${bp.issues.length !== 1 ? 's' : ''}</span>
        </div>
        ${bp.issues.map(issue => `
          <div style="display:flex;gap:10px;padding:10px 14px;margin:0 0 6px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.05);border-left:4px solid ${issue.issueType === 'overflow' ? '#EF4444' : issue.issueType === 'clipped' ? '#F97316' : issue.issueType === 'offscreen' ? '#8B5CF6' : '#EC4899'};break-inside:avoid;">
            <div style="font-size:20px;line-height:1;">${issue.issueType === 'overflow' ? '↔️' : issue.issueType === 'clipped' ? '✂️' : issue.issueType === 'offscreen' ? '🚫' : '⚠️'}</div>
            <div>
              <div style="font-weight:700;font-size:13px;color:#0f1b35;">${issue.label}</div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">${issue.detail}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `).join('')}
  </div>
  ` : ''}
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
