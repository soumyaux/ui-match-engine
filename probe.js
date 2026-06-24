// ──────────────────────────────────────────────────────────────────────────
// SHARED PROBE — single source of truth for the live-DOM design-token audit.
//
// This exact function runs in BOTH:
//   • the cloud engine  — engine.js: page.evaluate(probePage, designTokens)
//   • the browser extension — injected into the user's authenticated/VPN tab via
//     chrome.scripting.executeScript({ func: probePage, args: [designTokens] })
//
// It is pure browser-context JS: it only touches its `tokens` argument and DOM/
// window globals, so it serializes cleanly for both call sites. It returns the
// per-token results array and stashes shadow-scoring stats on window.__shadowScore.
//
// extension/probe.js MUST be byte-identical to this file (test-engine.js enforces it;
// run `npm run sync-probe` after editing). Deploy this file alongside engine.js.
// ──────────────────────────────────────────────────────────────────────────
function probePage(tokens) {
      function parseColorBrowser(raw) {
        if (!raw) return null;
        const s = String(raw).trim().toLowerCase();
        const h2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
        // Expand 3-digit hex shorthand (#fff → #ffffff)
        if (s.startsWith('#')) {
          if (s.length === 4) return '#' + s[1]+s[1]+s[2]+s[2]+s[3]+s[3];
          return s;
        }
        // rgb/rgba — comma or space separated
        const rm = s.match(/rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/);
        if (rm) return `#${h2(rm[1])}${h2(rm[2])}${h2(rm[3])}`;
        // hsl/hsla — comma or space separated
        const hm = s.match(/hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/);
        if (hm) {
          const h = parseFloat(hm[1]) / 360, sl = parseFloat(hm[2]) / 100, l = parseFloat(hm[3]) / 100;
          const q = l < 0.5 ? l * (1 + sl) : l + sl - l * sl, p = 2 * l - q;
          const hue = (t) => { t = ((t%1)+1)%1; return t<1/6 ? p+(q-p)*6*t : t<0.5 ? q : t<2/3 ? p+(q-p)*(2/3-t)*6 : p; };
          return `#${h2(hue(h+1/3)*255)}${h2(hue(h)*255)}${h2(hue(h-1/3)*255)}`;
        }
        // oklch(L C H) — convert via OKLAB → linear sRGB → sRGB
        const om = s.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (om) {
          const L = parseFloat(om[1]), C = parseFloat(om[2]), H = parseFloat(om[3]) * Math.PI / 180;
          const a = C * Math.cos(H), b2 = C * Math.sin(H);
          const l_ = (L+0.3963377774*a+0.2158037573*b2)**3, m_ = (L-0.1055613458*a-0.0638541728*b2)**3, s_ = (L-0.0894841775*a-1.2914855480*b2)**3;
          const lin = (c) => c > 0.0031308 ? 1.055*c**(1/2.4)-0.055 : 12.92*c;
          return `#${h2(lin(4.0767416621*l_-3.3077115913*m_+0.2309699292*s_)*255)}${h2(lin(-1.2684380046*l_+2.6097574011*m_-0.3413193965*s_)*255)}${h2(lin(-0.0041960863*l_-0.7034186147*m_+1.7076147010*s_)*255)}`;
        }
        // hwb(H W% B%)
        const wm = s.match(/hwb\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
        if (wm) {
          const H = parseFloat(wm[1])/360, W = parseFloat(wm[2])/100, B = parseFloat(wm[3])/100;
          if (W+B >= 1) { const g = Math.round(W/(W+B)*255); return `#${h2(g)}${h2(g)}${h2(g)}`; }
          const hue = (t) => { t = ((t%1)+1)%1; return t<1/6 ? 6*t : t<0.5 ? 1 : t<2/3 ? (2/3-t)*6 : 0; };
          const f = 1-W-B;
          return `#${h2((hue(H+1/3)*f+W)*255)}${h2((hue(H)*f+W)*255)}${h2((hue(H-1/3)*f+W)*255)}`;
        }
        return null;
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

      // Cache all stylesheet rules once — avoids repeated DOM walk per token
      const _cachedSheetRules = [];
      for (const sheet of document.styleSheets) {
        try { _cachedSheetRules.push(...Array.from(sheet.cssRules || [])); } catch(e) {}
      }
      const _inheritableProps = new Set(['color','font-size','font-family','font-weight','letter-spacing','line-height','text-align','text-decoration','text-transform','opacity']);
      // Lazy per-property rule index: only rules whose value for that property is a
      // var(). Rules without one could never make the check pass, so scanning this
      // short list is behavior-identical to walking ALL rules (with an expensive
      // node.matches per rule) for every token.
      const _varRulesByProp = new Map();
      function _getVarRules(cssProperty) {
        let rules = _varRulesByProp.get(cssProperty);
        if (!rules) {
          rules = [];
          for (const rule of _cachedSheetRules) {
            try {
              if (rule.selectorText && rule.style) {
                const val = rule.style.getPropertyValue(cssProperty);
                if (val && val.trim().startsWith('var(')) rules.push(rule);
              }
            } catch(e) {}
          }
          _varRulesByProp.set(cssProperty, rules);
        }
        return rules;
      }
      // Memo per (element, property) — ancestor walks re-checked the same page
      // wrappers for nearly every token. Styles are static at this point.
      const _varCheckMemo = new WeakMap();
      function hasCSSVarForProperty(el, cssProperty, checkAncestors) {
        const _check = (node) => {
          let memo = _varCheckMemo.get(node);
          if (memo && memo.has(cssProperty)) return memo.get(cssProperty);
          let found = false;
          try {
            const inlineVal = node.style.getPropertyValue(cssProperty);
            if (inlineVal && inlineVal.trim().startsWith('var(')) {
              found = true;
            } else {
              for (const rule of _getVarRules(cssProperty)) {
                try {
                  if (node.matches(rule.selectorText)) { found = true; break; }
                } catch(e) {}
              }
            }
          } catch(e) {}
          if (!memo) { memo = new Map(); _varCheckMemo.set(node, memo); }
          memo.set(cssProperty, found);
          return found;
        };
        if (_check(el)) return true;
        if (checkAncestors !== false && _inheritableProps.has(cssProperty)) {
          let parent = el.parentElement;
          while (parent && parent !== document.body) {
            if (_check(parent)) return true;
            parent = parent.parentElement;
          }
        }
        return false;
      }

      const results = [];
      // === DEDUPLICATION: Track DOM elements already checked ===
      // Multiple Figma tokens can hit the same DOM element — only report each once
      const seenElements = new Map(); // DOM element → index in results
      const checkedPositions = new Set();

      // === SHADOW SCORING (log-only — never displayed, never affects results) ===
      // Counts every comparison actually performed, BEFORE report dedup/filtering,
      // so the Action log can show an honest pass/fail ratio next to the displayed
      // score. Fully guarded: any error here is swallowed and the audit continues.
      const _shadow = { checked: 0, failed: 0, missing: 0 };
      function _shadowRuleCount(design, role, isTangible) {
        let n = 0;
        try {
          if (role === 'text' || design.fs) {
            if (design.fs && design.fs !== 'Mixed') n++;
            if (design.ff && design.ff !== 'Mixed') n++;
            if (design.fw && design.fw !== 'Mixed') n++;
            if (design.color && design.color !== 'Mixed') n++;
            if (design.ls !== undefined && design.ls !== 'Mixed') n++;
            if (design.lh !== undefined && design.lh !== 'Mixed') n++;
            if (design.ta && design.ta !== 'Mixed' && String(design.ta).toLowerCase() !== 'left') n++;
            if (design.td && design.td !== 'Mixed') n++;
            if (design.tt && design.tt !== 'Mixed') n++;
          }
          if (role !== 'text') {
            if (design.bg && design.bg.length > 0) n++;
            if (design.br !== undefined && design.br !== 'Mixed' && design.br > 0) n++;
            if (design.op !== undefined && design.op < 1) n++;
            if (design.bw !== undefined && design.bw > 0) n++;
            if (design.bc) n++;
          }
          if (role === 'container' || design.pad || design.gap !== undefined) {
            if (design.pad && Array.isArray(design.pad)) design.pad.forEach(p => { if (p > 0) n++; });
            if (design.gap !== undefined) n++;
          }
          if (role === 'leaf' && isTangible) {
            if (design.w !== undefined && design.w > 0) n++;
            if (design.h !== undefined && design.h > 0) n++;
          }
        } catch (e) {}
        return n;
      }

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
            // Shadow scoring: a missing element means every check it would have had
            // failed (floor of 4) — counted before report dedup hides duplicates
            try {
              const _n = Math.max(_shadowRuleCount(design, design.role || 'leaf', false), 4);
              _shadow.checked += _n;
              _shadow.failed += _n;
              _shadow.missing++;
            } catch (e) {}
            const missingKey = `missing_${Math.round(cx / 20)}_${Math.round(cy / 20)}`;
            if (!seenElements.has(missingKey)) {
              seenElements.set(missingKey, results.length);
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
        const _segments = (name && name !== 'unknown') ? name.split('/').map(s => s.trim()).filter(Boolean) : [];
        const figmaName = _segments.length >= 2
            ? _segments.slice(-2).join(' / ')
            : (_segments.length === 1 ? _segments[0] : null);
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
            const _figmaFF = design.ff.toLowerCase();
            const _liveFF = live.fontFamily.toLowerCase();
            const _strip = (s) => s.replace(/\b(variable|display|text|pro|neue)\b/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
            const _figmaN = _strip(_figmaFF);
            const _firstLive = _strip(_liveFF.split(',')[0].replace(/["']/g, '').trim());
            // 1. Direct substring check
            if (_liveFF.includes(_figmaN) || _firstLive.includes(_figmaN) || _figmaN.includes(_firstLive)) { /* match */ }
            // 2. System font aliases
            else if (/^(sf|san francisco|segoe)/.test(_figmaN) && /(-apple-system|system-ui|blinkmacsystemfont|segoe)/.test(_liveFF)) { /* match */ }
            // 3. First-word match (e.g. "Geist Sans" vs "Geist" → both start with "geist")
            else if (_figmaN.split(' ')[0].length >= 3 && _firstLive.includes(_figmaN.split(' ')[0])) { /* match */ }
            // 4. Font actually loaded on page (framework-renamed like __Inter_abc123)
            else if ([...document.fonts].some(f => { const fn = _strip(f.family.toLowerCase().replace(/["']/g, '')); return fn.includes(_figmaN) || _figmaN.includes(fn) || (fn.length >= 3 && _figmaN.includes(fn.split(' ')[0])); })) { /* match */ }
            else {
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
          if (design.color && design.color !== 'Mixed') {
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
          if (design.ta && design.ta !== 'Mixed' && design.ta.toLowerCase() !== 'left') {
            const ta = design.ta.toLowerCase();
            const expected = ta === 'justified' ? 'justify' : ta;
            const liveTA = live.textAlign === 'start' ? 'left' : live.textAlign === 'end' ? 'right' : live.textAlign;
            if (liveTA !== expected) errors.push('Text Align');
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

        // Reclassify style errors where live uses CSS var → token sync issue (yellow pill)
        const _p2c = {'Text Color':'color','Background Color':'background-color','Font Size':'font-size','Font Family':'font-family','Font Weight':'font-weight','Border Radius':'border-radius','Border Color':'border-color','Border Width':'border-width','Opacity':'opacity'};
        for (let _i = 0; _i < errors.length; _i++) {
          const _css = _p2c[errors[_i]];
          if (_css && hasCSSVarForProperty(el, _css)) errors[_i] = '~' + errors[_i];
        }

        // Shadow scoring: tally this element's comparisons before report dedup.
        // '~' entries are CSS-var sync warnings, not failures (parity with the
        // displayed score, which also excludes TOKEN_UNCONNECTED issues).
        try {
          const _failedHere = errors.filter(e => !e.startsWith('~')).length;
          _shadow.checked += Math.max(_shadowRuleCount(design, role, isTangible), _failedHere);
          _shadow.failed += _failedHere;
        } catch (e) {}

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

          const issueRect = {
            x: Math.round(rect.left + (window.scrollX || 0)),
            y: Math.round(rect.top + (window.scrollY || 0)),
            w: Math.round(rect.width || design.w || 50),
            h: Math.round(rect.height || design.h || 50)
          };

          // Skip container-level matches
          if (issueRect.w > window.innerWidth * 0.4 && issueRect.h > 300) return;

          if (layoutErrors.length > 0) {
            const idx = results.length;
            seenElements.set(elKey, idx);
            results.push({
              type: 'LAYOUT_SHIFT',
              element: elName,
              details: layoutErrors,
              rect: issueRect
            });
          }
          if (styleErrors.length > 0) {
            const idx = results.length;
            if (!seenElements.has(elKey)) seenElements.set(elKey, idx);
            results.push({
              type: styleErrors.some(e => !e.startsWith('~')) ? 'MINOR_DIFF' : 'TOKEN_UNCONNECTED',
              element: elName,
              details: styleErrors,
              rect: issueRect
            });
          }
        } else {
          // Values match — check if CSS design token variables are actually being used
          const cssPropsToCheck = [];
          if (design.color && (role === 'text' || design.fs))
            cssPropsToCheck.push({ css: 'color', label: 'Text Color' });
          if (design.bg?.[0] && role !== 'text')
            cssPropsToCheck.push({ css: 'background-color', label: 'Background' });
          if (design.fs && design.fs !== 'Mixed')
            cssPropsToCheck.push({ css: 'font-size', label: 'Font Size' });
          if (design.ff && design.ff !== 'Mixed')
            cssPropsToCheck.push({ css: 'font-family', label: 'Font Family' });

          const noneUseVars = cssPropsToCheck.length > 0
            && cssPropsToCheck.every(p => !hasCSSVarForProperty(el, p.css, false));

          if (noneUseVars) {
            const ucRect = {
              x: Math.round(rect.left + (window.scrollX || 0)),
              y: Math.round(rect.top + (window.scrollY || 0)),
              w: Math.round(rect.width || design.w || 50),
              h: Math.round(rect.height || design.h || 50)
            };
            if (ucRect.w > window.innerWidth * 0.4 && ucRect.h > 300) {
              results.push({ type: 'TOKEN_PASS', element: elName });
            } else {
              results.push({
                type: 'TOKEN_UNCONNECTED',
                element: elName,
                details: cssPropsToCheck.map(p => p.label),
                rect: ucRect
              });
            }
          } else {
            results.push({ type: 'TOKEN_PASS', element: elName });
          }
        }
      });
      try { window.__shadowScore = _shadow; } catch (e) {}
      return results;
}

if (typeof module !== "undefined" && module.exports) module.exports = { probePage };
