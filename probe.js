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
        // rgb/rgba - comma or space separated
        const rm = s.match(/rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/);
        if (rm) return `#${h2(rm[1])}${h2(rm[2])}${h2(rm[3])}`;
        // hsl/hsla - comma or space separated
        const hm = s.match(/hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/);
        if (hm) {
          const h = parseFloat(hm[1]) / 360, sl = parseFloat(hm[2]) / 100, l = parseFloat(hm[3]) / 100;
          const q = l < 0.5 ? l * (1 + sl) : l + sl - l * sl, p = 2 * l - q;
          const hue = (t) => { t = ((t%1)+1)%1; return t<1/6 ? p+(q-p)*6*t : t<0.5 ? q : t<2/3 ? p+(q-p)*(2/3-t)*6 : p; };
          return `#${h2(hue(h+1/3)*255)}${h2(hue(h)*255)}${h2(hue(h-1/3)*255)}`;
        }
        // oklch(L C H) - convert via OKLAB → linear sRGB → sRGB
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
      // "No background" computes to rgba(0, 0, 0, 0), and parseColorBrowser drops the
      // alpha (→ #000000), so transparency must be read from the raw value.
      function isTransparentBrowser(raw) {
        const s = String(raw || '').replace(/\s+/g, '').toLowerCase();
        return !s || s === 'transparent' || /^rgba\(.*,0(\.0+)?\)$/.test(s) || /\/0(\.0+)?%?\)$/.test(s);
      }
      // The background colour actually showing behind an element: its own, or the nearest
      // ancestor's when it is transparent. null when a gradient/image is in the way or
      // nothing paints a colour - the real colour is unknown, so don't guess.
      function effectiveBackgroundBrowser(el) {
        for (let node = el; node; node = node.parentElement) {
          const cs = window.getComputedStyle(node);
          if (!isTransparentBrowser(cs.backgroundColor)) return cs.backgroundColor;
          if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
        }
        return null;
      }
      // @font-face family → its src list, from readable (same-origin) stylesheets. Lets a
      // renamed web font ("__font_a1b2" → Inter-Regular.woff2) be traced to its real family.
      let _fontFaceSrcs = null;
      function fontFaceSourcesBrowser() {
        if (_fontFaceSrcs) return _fontFaceSrcs;
        _fontFaceSrcs = new Map();
        const walk = (rules) => {
          for (const rule of rules) {
            if (rule.type === CSSRule.FONT_FACE_RULE) {
              const fam = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase();
              const src = rule.style.getPropertyValue('src').toLowerCase();
              _fontFaceSrcs.set(fam, (_fontFaceSrcs.get(fam) || '') + ' ' + src);
            } else if (rule.cssRules) {
              walk(rule.cssRules);
            }
          }
        };
        for (const sheet of document.styleSheets) {
          try { walk(sheet.cssRules); } catch (e) { /* cross-origin sheet: unreadable */ }
        }
        return _fontFaceSrcs;
      }
      // How different two colours look (CIE76 ΔE in Lab): <3 barely visible, >10 a
      // clearly different colour. Drives "slightly off" vs "wrong colour".
      function deltaEBrowser(hexA, hexB) {
        const lab = (hex) => {
          const [r, g, b] = [1, 3, 5].map(i => {
            const v = parseInt(hex.slice(i, i + 2), 16) / 255;
            return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
          });
          const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
          const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
          const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
          const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
          return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
        };
        const a = lab(hexA), b = lab(hexB);
        return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      }
      // A short CSS selector a developer (or an AI) can paste: an id stops the walk,
      // otherwise tag + up to 2 readable classes (or :nth-of-type), max 4 levels.
      function selectorBrowser(el) {
        const parts = [];
        for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && parts.length < 4; n = n.parentElement) {
          if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break; }
          let sel = n.tagName.toLowerCase();
          const cls = [...n.classList].filter(c => /^[A-Za-z_-][\w-]*$/.test(c) && c.length < 30).slice(0, 2);
          if (cls.length) sel += '.' + cls.join('.');
          else if (n.parentElement) {
            const same = [...n.parentElement.children].filter(c => c.tagName === n.tagName);
            if (same.length > 1) sel += `:nth-of-type(${same.indexOf(n) + 1})`;
          }
          parts.unshift(sel);
        }
        return parts.join(' > ');
      }
      const normTextBrowser = (t) => String(t || '').normalize('NFKC').toLowerCase()
        .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
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

      // Cache all stylesheet rules once - avoids repeated DOM walk per token
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
      // Memo per (element, property) - ancestor walks re-checked the same page
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
      // Multiple Figma tokens can hit the same DOM element - only report each once
      const seenElements = new Map(); // DOM element → index in results
      const checkedMatches = new Map(); // matched DOM element → roles already checked on it

      // === SHADOW SCORING (log-only - never displayed, never affects results) ===
      // Counts every comparison actually performed, BEFORE report dedup/filtering,
      // so the Action log can show an honest pass/fail ratio next to the displayed
      // score. Fully guarded: any error here is swallowed and the audit continues.
      // Small (1-2px) differences are shown in the report but never counted as failed.
      const _shadow = { checked: 0, failed: 0, missing: 0, unmatched: 0 };
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

      // What each check is about - drives the report's category chips
      const CATEGORY = {
        'Missing Element': 'layout', 'Width': 'layout', 'Height': 'layout', 'Position': 'layout',
        'Font Size': 'typography', 'Font Family': 'typography', 'Font Weight': 'typography', 'Line Height': 'typography',
        'Letter Spacing': 'typography', 'Text Align': 'typography', 'Text Decoration': 'typography', 'Text Transform': 'typography',
        'Text Color': 'colour', 'Background Color': 'colour', 'Border Color': 'colour', 'Opacity': 'colour',
        'Padding Top': 'spacing', 'Padding Right': 'spacing', 'Padding Bottom': 'spacing', 'Padding Left': 'spacing', 'Gap': 'spacing',
        'Text Content': 'text',
        'Border Radius': 'details', 'Border Width': 'details', 'Shadow': 'details',
        'Missing Image': 'images', 'Broken Image': 'images', 'Image Width': 'images', 'Image Height': 'images',
        'Stretched Image': 'images', 'Icon Color': 'images',
      };
      const _sevRank = { low: 1, medium: 2, high: 3 };
      // An issue's severity is its worst check; its category is that check's category
      const summariseChecks = (checks) => {
        let top = null;
        for (const c of checks) if (!top || _sevRank[c.severity] > _sevRank[top.severity]) top = c;
        return top ? { severity: top.severity, category: top.category } : { severity: 'low', category: 'details' };
      };
      const _r2 = v => Math.round(v * 100) / 100;

      // === OVERLAYS (R8) ===
      // A cookie banner or chat widget is fixed on top of the content and isn't in the
      // design: probing through it compares the design against the banner. Hide
      // fixed/sticky elements whose box matches no design layer for the duration of the
      // probe (restored before returning - in the extension this is the user's own tab).
      const _hiddenOverlays = [];
      try {
        const _layers = tokens.filter(t => !String(t.name || '').startsWith('_') && (t.w || 0) >= 20 && (t.h || 0) >= 20);
        const _iou = (r, t) => {
          const ix = Math.max(0, Math.min(r.right, t.x + t.w) - Math.max(r.left, t.x));
          const iy = Math.max(0, Math.min(r.bottom, t.y + t.h) - Math.max(r.top, t.y));
          const u = r.width * r.height + t.w * t.h - ix * iy;
          return u > 0 ? (ix * iy) / u : 0;
        };
        for (const n of document.querySelectorAll('body *')) {
          const pos = window.getComputedStyle(n).position;
          if (pos !== 'fixed' && pos !== 'sticky') continue;
          const r = n.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          if (_layers.some(t => _iou(r, { x: t.x || 0, y: t.y || 0, w: t.w, h: t.h }) >= 0.5)) continue;
          _hiddenOverlays.push([n, n.style.getPropertyValue('visibility'), n.style.getPropertyPriority('visibility')]);
          n.style.setProperty('visibility', 'hidden', 'important');
        }
      } catch (e) {}

      const _deferred = []; // layers pass 1 didn't find
      const _matched = [];  // found layers: design box + live offset (ox, oy)
      const _failedBy = new Map(); // design layer → labels it failed (explains knock-on shifts)
      const checkToken = (design, pass, shift) => {
        const name = design.name || 'unknown';
        // Skip tiny spacer/divider tokens that aren't meaningful UI components
        if ((design.w || 0) < 20 && (design.h || 0) < 20) return;

        // What the layer is (v2 plugin, decided by content): image | icon | decor.
        // Decorative layers (blurs, gradients, large shapes) are never compared.
        const kind = design.kind;
        if (kind === 'decor') return;
        const isMediaLayer = kind === 'image' || kind === 'icon';

        // Older plugins send no kind: fall back to guessing from the layer name/type
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
        const isImageOrDecor = kind ? false : (hasDecorativeName || isPureShape);

        // Where the layer should be on the page: its design box, moved by the offset of the
        // layer that contains it when that one was found shifted (pass 2 below)
        const _dx = (design.x || 0) + shift.x, _dy = (design.y || 0) + shift.y, _dw = design.w || 0, _dh = design.h || 0;
        const cx = _dx + _dw / 2;
        const cy = _dy + _dh / 2;

        if (cx <= 0 && cy <= 0) return;

        // Multi-point probing: check center + 4 inner corners to avoid false negatives
        // from responsive shifts where the center pixel misses the element
        const probePoints = [
          [cx, cy],
          [_dx + _dw * 0.25, _dy + _dh * 0.25],
          [_dx + _dw * 0.75, _dy + _dh * 0.25],
          [_dx + _dw * 0.25, _dy + _dh * 0.75],
          [_dx + _dw * 0.75, _dy + _dh * 0.75],
        ];
        // elementFromPoint returns the DEEPEST element at a point (a card's centre hits
        // its <p>), so walk UP from each hit and pick the element whose box best matches
        // the design layer: highest overlap, size within ±15% on each axis. Text layers
        // may also match on the box of the text itself (a wide <p> holding short text).
        const _isTextLayer = design.role === 'text' || !!design.fs;
        // w/h: size to compare (layout size, so a rotated element isn't judged by its
        // enlarged bounding box); r: the on-screen box used for the overlap.
        let _scoredRect = null; // the box the last score was computed on
        const _overlap = (r) => {
          const ix = Math.max(0, Math.min(r.right, _dx + _dw) - Math.max(r.left, _dx));
          const iy = Math.max(0, Math.min(r.bottom, _dy + _dh) - Math.max(r.top, _dy));
          const union = r.width * r.height + _dw * _dh - ix * iy;
          return union > 0 ? (ix * iy) / union : 0;
        };
        const _boxScore = (r, w, h) => {
          if (!r) return 0;
          w = w ?? r.width; h = h ?? r.height;
          if (Math.abs(w - _dw) > Math.max(_dw * 0.15, 4) || Math.abs(h - _dh) > Math.max(_dh * 0.15, 4)) return 0;
          _scoredRect = r;
          return _overlap(r);
        };
        // Width of the text itself, height of the element's content box: a glyph range is
        // shorter than Figma's text box, which spans the full line-height.
        const _textBox = (node) => {
          try {
            const range = document.createRange();
            range.selectNodeContents(node);
            const t = range.getBoundingClientRect();
            if (!(t.width > 0)) return null;
            const r = node.getBoundingClientRect(), cs = window.getComputedStyle(node);
            const padTop = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
            const padBottom = (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.paddingBottom) || 0);
            const top = r.top + padTop, bottom = r.bottom - padBottom;
            if (!(bottom > top)) return null;
            return { rect: { left: t.left, right: t.right, top, bottom, width: t.width, height: bottom - top },
              w: t.width, h: (node.offsetHeight ?? r.height) - padTop - padBottom };
          } catch (e) { return null; }
        };
        const _textScore = (node) => {
          const tb = _textBox(node);
          return tb ? _boxScore(tb.rect, tb.w, tb.h) : 0;
        };
        // A layer that draws nothing (no fill, border, radius or shadow) is only seen through
        // its content, so it may also match on the content's extent: a hug-content link is
        // the same thing as an <a> stretched to its column's width.
        const _drawsNothing = !_isTextLayer && !(design.bg && design.bg.length) && !design.bc && !design.br && !design.shadow;
        const _contentScore = (node) => {
          try {
            const range = document.createRange();
            range.selectNodeContents(node);
            const t = range.getBoundingClientRect();
            return t.width > 0 ? _boxScore(t) : 0;
          } catch (e) { return 0; }
        };
        // Second chance, for an element that grew or shrank past the ±15% size window (a
        // longer button label): no size limit, but it must cover the layer's centre and
        // overlap it well. Used only once the offset-corrected pass 2 found nothing better.
        const _looseScore = (r) => (r && r.width > 0 && r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy) ? _overlap(r) : 0;
        // The layer's box is empty on the page when every probe point lands on a wrapper
        // that encloses the whole box, is clearly bigger, and holds no text or media of its
        // own (the bare grid cell where a card was), and no same-size element sits close
        // by in that wrapper. A moved or resized element still covers part of its box or
        // sits next to it, so it never counts as empty.
        const _sizeOk = (w, h) => Math.abs(w - _dw) <= Math.max(_dw * 0.15, 4) && Math.abs(h - _dh) <= Math.max(_dh * 0.15, 4);
        const _near = Math.max(24, Math.min(_dw, _dh));
        const _hasSameSizeNear = (wrapper) => [...wrapper.querySelectorAll('*')].some(d => {
          const rects = [d.getBoundingClientRect()];
          if (_isTextLayer || _drawsNothing) {
            try { const range = document.createRange(); range.selectNodeContents(d); rects.push(range.getBoundingClientRect()); } catch (e) {}
          }
          return rects.some(r => r.width > 0 && _sizeOk(r.width, r.height) &&
            Math.abs(r.left + r.width / 2 - cx) <= _near && Math.abs(r.top + r.height / 2 - cy) <= _near);
        });
        const _boxIsEmpty = () => {
          const wrappers = new Set();
          for (const [px, py] of probePoints) {
            const p = document.elementFromPoint(px, py);
            if (!p || p === document.body || p === document.documentElement) continue;
            const r = p.getBoundingClientRect();
            const encloses = r.left <= _dx + 1 && r.top <= _dy + 1 && r.right >= _dx + _dw - 1 && r.bottom >= _dy + _dh - 1;
            const ownText = [...p.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
            const media = /^(img|svg|video|canvas|iframe|picture|input|textarea|select|button)$/i.test(p.tagName);
            if (!encloses || r.width * r.height < 1.5 * _dw * _dh || ownText || media) return false;
            wrappers.add(p);
          }
          return ![...wrappers].some(_hasSameSizeNear);
        };
        let hit = null, el = null, bestScore = 0, bestRect = null, bestByContent = false;
        let looseEl = null, looseScore = 0, looseRect = null;
        for (const [px, py] of probePoints) {
          const probe = document.elementFromPoint(px, py);
          if (!probe || probe === document.body || probe === document.documentElement) continue;
          if (!hit) hit = probe;
          for (let node = probe; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            // [score, matched on content extent rather than a box]
            const tries = [[() => _boxScore(node.getBoundingClientRect(), node.offsetWidth, node.offsetHeight), false]];
            if (_isTextLayer) tries.push([() => _textScore(node), false]);
            if (_drawsNothing) tries.push([() => _contentScore(node), true]);
            for (const [t, byContent] of tries) {
              _scoredRect = null;
              const score = t();
              // Strictly greater: on a tie the deeper element (closer to the content) wins
              if (score > bestScore) { bestScore = score; el = node; bestRect = _scoredRect; bestByContent = byContent; }
            }
            if (pass === 2) {
              const lr = _isTextLayer ? (_textBox(node) || {}).rect : node.getBoundingClientRect();
              const ls = _looseScore(lr);
              if (ls > looseScore) { looseScore = ls; looseEl = node; looseRect = lr; }
            }
          }
        }
        // Pass 1 leaves anything not found for pass 2, which retries it at the offset of
        // the layer containing it before deciding it moved or is missing
        if (pass === 1 && (!el || bestScore < 0.5)) { _deferred.push(design); return; }
        let matchedLoose = false;
        if ((!el || bestScore < 0.5) && looseScore >= 0.6) {
          el = looseEl; bestRect = looseRect; bestScore = looseScore; bestByContent = false; matchedLoose = true;
        }
        if (el && bestScore >= 0.5 && bestRect) {
          _matched.push({ design, el, x: design.x || 0, y: design.y || 0, w: _dw, h: _dh, live: bestRect, byContent: bestByContent,
            loose: matchedLoose, ox: bestRect.left - (design.x || 0), oy: bestRect.top - (design.y || 0) });
        }
        if (hit && bestScore < 0.5) {
          // Something is there but nothing matches this layer's box (moved or resized):
          // comparing properties against an unrelated element only produces false alarms.
          if (!_boxIsEmpty()) {
            try { _shadow.unmatched++; } catch (e) {}
            return;
          }
          el = null; // the box is empty: the element is missing
        }

        // Use the Figma layer name for issue titles - much more useful for designers.
        // Layers inside a component instance carry its inner names ("Label"): use the
        // instance's name instead. Clean it: last 2 path segments ("A / B / Button" → "B / Button")
        const _label = design.inst || name;
        const _segments = (_label && _label !== 'unknown') ? _label.split('/').map(s => s.trim()).filter(Boolean) : [];
        const figmaName = _segments.length >= 2
            ? _segments.slice(-2).join(' / ')
            : (_segments.length === 1 ? _segments[0] : null);
        const _locator = { name: _label, section: design.section || null, figmaNodeId: design.id || null };

        // === MISSING ELEMENT: Figma has content here but live page has nothing ===
        if (!el || el === document.body || el === document.documentElement) {
          // Skip image/decorative tokens - they cause false positives
          if (isImageOrDecor) return;
          // Only report if the Figma token is large enough to be a real component (not a
          // spacer). Text is content at any size (a missing nav link), and so are images/icons.
          const _bigEnough = _isTextLayer || (isMediaLayer && _dw >= 16 && _dh >= 16) || ((design.w || 0) > 50 && (design.h || 0) > 50);
          if (_bigEnough) {
            // Shadow scoring: a missing element means every check it would have had
            // failed (floor of 4) - counted before report dedup hides duplicates
            try {
              const _n = Math.max(_shadowRuleCount(design, design.role || 'leaf', false), 4);
              _shadow.checked += _n;
              _shadow.failed += _n;
              _shadow.missing++;
            } catch (e) {}
            const _mx = (design.x || 0) + _dw / 2, _my = (design.y || 0) + _dh / 2;
            const missingKey = `missing_${Math.round(_mx / 20)}_${Math.round(_my / 20)}`;
            if (!seenElements.has(missingKey)) {
              seenElements.set(missingKey, results.length);
              const cat = isMediaLayer ? 'images' : 'layout';
              results.push({
                type: 'LAYOUT_SHIFT',
                element: 'Missing Element',
                details: [`Element in Figma ("${name}") not found on live page at position (${Math.round(_mx)}, ${Math.round(_my)}). Size: ${design.w}×${design.h}px`],
                rect: { x: Math.round(design.x || 0), y: Math.round(design.y || 0), w: Math.round(design.w || 50), h: Math.round(design.h || 50) },
                ..._locator,
                category: cat, severity: 'high',
                text: typeof design.text === 'string' ? design.text.slice(0, 60) : null,
                checks: [{ prop: 'presence', label: isMediaLayer ? 'Missing Image' : 'Missing Element', category: cat,
                  design: 'present', live: 'missing', severity: 'high', confidence: 'measured' }]
              });
            }
          }
          return;
        }

        // One check per matched element and role: a button and its label are separate
        // layers on the same <a>, but two frames with the same box (a grid and its only
        // row) are the same check.
        const _checkedRoles = checkedMatches.get(el) || new Set();
        if (_checkedRoles.has(design.role || 'leaf')) return;
        _checkedRoles.add(design.role || 'leaf');
        checkedMatches.set(el, _checkedRoles);

        // === SKIP IRRELEVANT ELEMENTS ===
        const tag = el.tagName.toUpperCase();
        if (!isMediaLayer) {
          // Skip media/image/chart elements - these are dynamic content that always differs from Figma
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
        }

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
        const elName = figmaName || getElementName(el);
        const role = design.role || 'leaf'; // text | container | leaf

        // Determine if this DOM element is a tangible interactive component
        const tangibleTags = ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'LABEL'];
        const isTangible = tangibleTags.includes(tag) || el.getAttribute('role') === 'button';

        // === CHECKS ===
        // Every failed comparison records a check object (design value, live value,
        // difference) plus its label, which stays in `details` for the PDF and older
        // plugin/extension versions. A 1-2px difference is `small`: shown, not scored.
        const errors = [];            // labels, in order (legacy `details`)
        const checks = [];
        const smallLabels = new Set(); // labels whose every check is small
        let performed = 0;
        const fail = (label, c) => {
          const check = Object.assign({ label, category: CATEGORY[label] || 'details', confidence: 'measured' }, c);
          if (!check.severity) check.severity = check.small ? 'low' : 'medium';
          checks.push(check);
          if (!errors.includes(label)) errors.push(label);
          if (checks.every(o => o.label !== label || o.small)) smallLabels.add(label); else smallLabels.delete(label);
        };
        // Numeric comparison in px. Below `tol` is rendering noise; up to `smallMax` is small.
        const px = (label, prop, dv, lv, opt = {}) => {
          if (typeof dv !== 'number' || !isFinite(dv) || typeof lv !== 'number' || !isFinite(lv)) return;
          performed++;
          const diff = lv - dv, ad = Math.abs(diff);
          if (ad < (opt.tol ?? 0.5)) return;
          const small = ad <= (opt.smallMax ?? 2);
          const big = ad > 8 || (Math.abs(dv) > 0 && ad / Math.abs(dv) > 0.25);
          fail(label, { prop, design: _r2(dv), live: _r2(lv), unit: 'px', diff: _r2(diff), small,
            severity: opt.severity || (small ? 'low' : big ? 'high' : 'medium'), confidence: opt.confidence || 'measured' });
        };
        const colour = (label, prop, designHex, liveRaw) => {
          const a = parseColorBrowser(designHex), b = parseColorBrowser(liveRaw);
          if (!a || !b) return;
          performed++;
          if (colorsMatchBrowser(designHex, liveRaw)) return;
          const dE = (a.length === 7 && b.length === 7) ? Math.round(deltaEBrowser(a, b) * 10) / 10 : null;
          const small = dE !== null && dE < 3;
          fail(label, { prop, design: a.toUpperCase(), live: b.toUpperCase(), unit: 'color', deltaE: dE, small,
            severity: small ? 'low' : (dE === null || dE > 10) ? 'high' : 'medium' });
        };

        // ═══════════════════════════════════════
        // TEXT PROPERTIES (only for text tokens)
        // ═══════════════════════════════════════
        if (role === 'text' || design.fs) {
          const fsNum = typeof design.fs === 'number' ? design.fs : null;
          if (fsNum) px('Font Size', 'font-size', fsNum, parseFloat(live.fontSize));
          if (design.ff && design.ff !== 'Mixed' && live.fontFamily) {
            performed++;
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
            // 4. A renamed web font in the element's OWN stack whose file is the design font.
            //    (The font being loaded elsewhere on the page says nothing about this element.)
            else if (_liveFF.split(',').some(f => {
              const src = fontFaceSourcesBrowser().get(f.replace(/["']/g, '').trim());
              return src && src.replace(/[-_]/g, ' ').includes(_figmaN);
            })) { /* match */ }
            else {
              fail('Font Family', { prop: 'font-family', design: design.ff, live: live.fontFamily.split(',')[0].replace(/["']/g, '').trim(), severity: 'high' });
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
            performed++;
            if (live.fontWeight !== expectedWeight && live.fontWeight !== String(expectedWeight)) {
              fail('Font Weight', { prop: 'font-weight', design: Number(expectedWeight) || design.fw, live: Number(live.fontWeight) || live.fontWeight, severity: 'medium' });
            }
          }
          if (design.color && design.color !== 'Mixed') colour('Text Color', 'color', design.color, live.color);
          // Letter spacing: real values are around -1…2px, so the tolerance is 0.25px.
          // No value from the plugin means 0 (it only sends non-zero spacing).
          const liveLs = live.letterSpacing === 'normal' ? 0 : parseFloat(live.letterSpacing) || 0;
          let expLs = null;
          if (typeof design.ls === 'number') expLs = design.ls;
          else if (typeof design.lsPct === 'number' && fsNum) expLs = design.lsPct / 100 * fsNum;
          else if (design.ls === undefined && design.lsPct === undefined && fsNum && design.ff && design.ff !== 'Mixed') expLs = 0;
          if (expLs !== null) px('Letter Spacing', 'letter-spacing', expLs, liveLs, { tol: 0.25, smallMax: 0, severity: 'medium' });
          // Line height: px, or % of the font size. "normal" is estimated at 1.2 × font size.
          let expLh = null;
          if (typeof design.lh === 'number' && design.lh > 0) expLh = design.lh;
          else if (typeof design.lhPct === 'number' && fsNum) expLh = design.lhPct / 100 * fsNum;
          if (expLh) {
            const lhNormal = live.lineHeight === 'normal';
            const liveLh = lhNormal ? 1.2 * parseFloat(live.fontSize) : parseFloat(live.lineHeight);
            px('Line Height', 'line-height', expLh, liveLh, lhNormal ? { confidence: 'estimated', tol: 1.5 } : {});
          }
          if (design.ta && design.ta !== 'Mixed' && design.ta.toLowerCase() !== 'left') {
            const ta = design.ta.toLowerCase();
            const expected = ta === 'justified' ? 'justify' : ta;
            const liveTA = live.textAlign === 'start' ? 'left' : live.textAlign === 'end' ? 'right' : live.textAlign;
            performed++;
            if (liveTA !== expected) fail('Text Align', { prop: 'text-align', design: expected, live: liveTA, severity: 'low' });
          }
          if (design.td && design.td !== 'Mixed') {
            const expected = design.td === 'strikethrough' ? 'line-through' : design.td;
            performed++;
            if (!live.textDecoration.includes(expected)) fail('Text Decoration', { prop: 'text-decoration', design: expected, live: live.textDecorationLine || live.textDecoration, severity: 'low' });
          }
          if (design.tt && design.tt !== 'Mixed') {
            performed++;
            if (live.textTransform !== design.tt) fail('Text Transform', { prop: 'text-transform', design: design.tt, live: live.textTransform, severity: 'low' });
          }
          // Text content: the words themselves. Either side may hold a part of the other
          // (the plugin sends the first 80 characters; a heading may be split into spans).
          if (typeof design.text === 'string' && design.text.trim()) {
            const liveText = (el.innerText || el.textContent || '').trim();
            const dt = normTextBrowser(design.text), lt = normTextBrowser(liveText);
            if (lt) {
              performed++;
              if (!lt.includes(dt) && !dt.includes(lt)) {
                fail('Text Content', { prop: 'text', design: design.text, live: liveText.slice(0, 80), unit: 'text', severity: 'medium' });
              }
            }
          }
        }

        // ═══════════════════════════════════════
        // VISUAL PROPERTIES (containers + leaves)
        // ═══════════════════════════════════════
        if (role !== 'text') {
          if (design.bg && design.bg.length > 0) {
            const liveBg = effectiveBackgroundBrowser(el);
            if (liveBg) colour('Background Color', 'background-color', design.bg[0], liveBg);
          }
          if (typeof design.br === 'number' && design.br > 0) {
            // A radius beyond half the short side draws the same pill/circle, so compare
            // what is drawn (a 999px pill equals a 9999px pill)
            const liveR = parseFloat(live.borderTopLeftRadius) || parseFloat(live.borderRadius) || 0;
            const half = Math.min(rect.width, rect.height) / 2, dHalf = Math.min(_dw, _dh) / 2;
            px('Border Radius', 'border-radius', Math.min(design.br, dHalf), Math.min(liveR, half));
          }
          if (design.op !== undefined && design.op < 1) {
            const liveOp = parseFloat(live.opacity);
            performed++;
            if (Math.abs(liveOp - design.op) > 0.05) fail('Opacity', { prop: 'opacity', design: _r2(design.op), live: _r2(liveOp), severity: 'medium' });
          }
          // Borders per side: the borderWidth/borderColor shorthands only give the TOP
          // side, and a side without a border reports the text colour.
          const _sideNames = ['Top', 'Right', 'Bottom', 'Left'];
          const _sides = _sideNames.map((s, i) => {
            const w = parseFloat(live['border' + s + 'Width']) || 0, st = live['border' + s + 'Style'];
            return { i, w, color: live['border' + s + 'Color'], drawn: w > 0 && st !== 'none' && st !== 'hidden' };
          });
          const _liveDrawn = _sides.filter(s => s.drawn);
          // Sides the design has: per-side weights (bws) if sent; a uniform stroke (numeric
          // bw) is all four; mixed weights (bw absent) → trust the sides the page draws.
          // bw alone isn't enough - Figma keeps a default weight on layers with no stroke.
          const _designSides = Array.isArray(design.bws) ? _sides.filter(s => design.bws[s.i] > 0)
            : design.bc && typeof design.bw === 'number' && design.bw > 0 ? _sides
            : design.bc ? _liveDrawn : [];
          const _designWeight = (s) => Array.isArray(design.bws) ? design.bws[s.i] : design.bw;
          if (_liveDrawn.length === 0) {
            // The design has a border and the page draws none - unless it draws the ring
            // another way (box-shadow / outline, e.g. Tailwind `ring`), which can't be compared
            const _ring = (live.boxShadow && live.boxShadow !== 'none') || (parseFloat(live.outlineWidth) > 0 && live.outlineStyle !== 'none');
            if ((design.bc || _designSides.length > 0) && !_ring) {
              performed++;
              const w = typeof design.bw === 'number' ? design.bw : (_designSides.length ? _designWeight(_designSides[0]) : 1);
              fail('Border Width', { prop: 'border-width', design: w, live: 0, unit: 'px', diff: -w, severity: 'medium' });
            }
          } else if (_designSides.length > 0) {
            for (const s of _designSides) {
              const side = 'border-' + _sideNames[s.i].toLowerCase() + '-width';
              if (!s.drawn) {
                performed++;
                const w = _designWeight(s);
                fail('Border Width', { prop: side, design: typeof w === 'number' ? w : 'border', live: 0, unit: 'px', severity: 'medium' });
              } else if (typeof _designWeight(s) === 'number') {
                px('Border Width', side, _designWeight(s), s.w);
              }
            }
            if (design.bc) {
              const drawn = _designSides.filter(s => s.drawn);
              const off = drawn.find(s => !colorsMatchBrowser(design.bc, s.color)) || drawn[0];
              if (off) colour('Border Color', 'border-color', design.bc, off.color);
            }
          }
          // Shadow: missing, or a different offset/blur (colour alpha isn't sent by the plugin)
          if (Array.isArray(design.shadow) && design.shadow.length) {
            const d = design.shadow[0];
            const liveSh = live.boxShadow;
            const dStr = `${d.x}px ${d.y}px ${d.blur}px${d.spread ? ' ' + d.spread + 'px' : ''}`;
            if (!liveSh || liveSh === 'none') {
              performed++;
              fail('Shadow', { prop: 'box-shadow', design: dStr, live: 'none', severity: 'medium' });
            } else {
              const first = liveSh.split(/,(?![^(]*\))/)[0].replace(/[a-z]+\([^)]*\)/gi, '');
              const nums = (first.match(/-?[\d.]+(?=px)/g) || []).map(parseFloat);
              if (nums.length >= 3) {
                px('Shadow', 'box-shadow-x', d.x, nums[0], { tol: 1 });
                px('Shadow', 'box-shadow-y', d.y, nums[1], { tol: 1 });
                px('Shadow', 'box-shadow-blur', d.blur, nums[2], { tol: 1 });
              }
            }
          }
        }

        // ═══════════════════════════════════════
        // SPACING PROPERTIES (containers only)
        // ═══════════════════════════════════════
        if (role === 'container' || design.pad || design.gap !== undefined) {
          if (design.pad && Array.isArray(design.pad)) {
            const [pt, pr, pb, pl] = design.pad;
            [['Top', pt, live.paddingTop], ['Right', pr, live.paddingRight], ['Bottom', pb, live.paddingBottom], ['Left', pl, live.paddingLeft]]
              .forEach(([side, figma, lv]) => {
                if (figma > 0) px('Padding ' + side, 'padding-' + side.toLowerCase(), figma, parseFloat(lv) || 0);
              });
          }
          if (design.gap !== undefined) {
            // The gap between items along the layout direction: column-gap in a row,
            // row-gap in a column (the `gap` shorthand reads "row col")
            const _column = /flex/.test(live.display) && /column/.test(live.flexDirection);
            const g = _column ? live.rowGap : live.columnGap;
            px('Gap', 'gap', design.gap, g === 'normal' ? 0 : parseFloat(g) || 0);
          }
        }

        // ═══════════════════════════════════════
        // DIMENSIONS: tangible leaves, and boxes that draw something (cards, pills,
        // images, icons) - not text or full-width wrappers, whose size follows the page
        // ═══════════════════════════════════════
        const _drawsBox = (design.bg && design.bg.length) || design.bc || design.br || (design.shadow && design.shadow.length);
        const _sizeChecked = role !== 'text' && !bestByContent &&
          ((role === 'leaf' && isTangible) || isMediaLayer || (_drawsBox && _dw < window.innerWidth * 0.9));
        if (_sizeChecked) {
          // Layout size, so a rotated element isn't judged by its bounding box
          const transformed = live.transform && live.transform !== 'none';
          const lw = transformed && typeof el.offsetWidth === 'number' ? el.offsetWidth : rect.width;
          const lh = transformed && typeof el.offsetHeight === 'number' ? el.offsetHeight : rect.height;
          // A box sized by its text (a hug-content button) inherits the browser's text
          // rendering, which differs from Figma's by up to ~1.5px: not a design difference
          const tol = kind === 'icon' ? 0.5 : (el.innerText || '').trim() ? 2 : 1;
          if (design.w > 0) px(isMediaLayer ? 'Image Width' : 'Width', 'width', design.w, lw, { tol });
          if (design.h > 0) px(isMediaLayer ? 'Image Height' : 'Height', 'height', design.h, lh, { tol });
        }

        // IMAGES & ICONS: check the box, never the picture
        if (isMediaLayer) {
          const img = tag === 'IMG' ? el : el.querySelector?.('img');
          if (img) {
            performed++;
            if (img.complete && img.naturalWidth === 0) {
              fail('Broken Image', { prop: 'image', design: 'loaded', live: 'broken', severity: 'high' });
            } else if (img.naturalWidth > 0 && img.naturalHeight > 0 && window.getComputedStyle(img).objectFit === 'fill') {
              const ir = img.getBoundingClientRect();
              const want = img.naturalWidth / img.naturalHeight, got = ir.width / Math.max(1, ir.height);
              if (Math.abs(got - want) / want > 0.05) fail('Stretched Image', { prop: 'aspect-ratio', design: _r2(want), live: _r2(got), unit: 'ratio', severity: 'medium' });
            }
          }
          // Single-colour SVG icon only: its one fill/stroke colour vs the vector's fill
          const svg = el.closest?.('svg') || el.querySelector?.('svg');
          if (design.iconColor && svg) {
            const cols = new Set();
            svg.querySelectorAll('path, circle, rect, polygon, polyline, line, ellipse').forEach(sh => {
              const cs = window.getComputedStyle(sh);
              [cs.fill, cs.stroke].forEach(c => { if (c && c !== 'none' && !/^url/.test(c) && !isTransparentBrowser(c)) cols.add(parseColorBrowser(c)); });
            });
            cols.delete(null);
            if (cols.size === 1) colour('Icon Color', 'fill', design.iconColor, [...cols][0]);
          }
        }

        // Reclassify style errors where live uses CSS var → token sync issue (yellow pill)
        const _p2c = {'Text Color':'color','Background Color':'background-color','Font Size':'font-size','Font Family':'font-family','Font Weight':'font-weight','Border Radius':'border-radius','Border Color':'border-color','Border Width':'border-width','Opacity':'opacity'};
        for (let _i = 0; _i < errors.length; _i++) {
          const _css = _p2c[errors[_i]];
          if (_css && hasCSSVarForProperty(el, _css)) {
            checks.forEach(c => { if (c.label === errors[_i]) c.tokenVar = true; });
            errors[_i] = '~' + errors[_i];
          }
        }
        const _counted = errors.filter(e => !e.startsWith('~') && !smallLabels.has(e));
        _failedBy.set(design, new Set(errors.map(e => e.replace(/^~/, ''))));

        // Shadow scoring: tally this element's comparisons before report dedup.
        // '~' entries are CSS-var sync warnings and small entries are 1-2px - neither is
        // a failure (parity with the displayed score, which excludes TOKEN_UNCONNECTED).
        try {
          _shadow.checked += Math.max(performed, _counted.length);
          _shadow.failed += _counted.length;
        } catch (e) {}

        const _elText = (() => {
          if (tag === 'IMG') return el.alt || null;
          const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
          return t ? t.slice(0, 60) : null;
        })();
        const _meta = (subset) => Object.assign({}, _locator, summariseChecks(subset),
          { selector: selectorBrowser(el), text: _elText, checks: subset });
        const _mergeInto = (existing, labels, subset) => {
          labels.forEach(e => { if (!existing.details.includes(e)) existing.details.push(e); });
          existing.checks = (existing.checks || []).concat(subset.filter(c => !(existing.checks || []).some(o => o.prop === c.prop && o.label === c.label)));
          Object.assign(existing, summariseChecks(existing.checks));
        };

        // === DEDUP: check if this DOM element was already reported ===
        // Use a unique key based on element tag + position to detect same element
        const elKey = `${tag}_${Math.round(rect.left)}_${Math.round(rect.top)}_${Math.round(rect.width)}`;
        if (errors.length > 0) {
          if (seenElements.has(elKey)) {
            // Merge errors into existing issue
            const existing = results[seenElements.get(elKey)];
            if (existing) _mergeInto(existing, errors, checks);
            return; // Don't create a new issue
          }

          const _isLayout = e => e === 'Width' || e === 'Height';
          const layoutErrors = errors.filter(_isLayout);
          const styleErrors = errors.filter(e => !_isLayout(e));
          const _checksFor = (labels) => checks.filter(c => labels.some(l => l.replace(/^~/, '') === c.label));

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
            results.push(Object.assign({
              type: 'LAYOUT_SHIFT',
              element: elName,
              details: layoutErrors,
              rect: issueRect
            }, _meta(_checksFor(layoutErrors))));
          }
          if (styleErrors.length > 0) {
            const idx = results.length;
            if (!seenElements.has(elKey)) seenElements.set(elKey, idx);
            const _notes = !styleErrors.some(e => !e.startsWith('~'));
            const issue = Object.assign({
              type: _notes ? 'TOKEN_UNCONNECTED' : 'MINOR_DIFF',
              element: elName,
              details: styleErrors,
              rect: issueRect
            }, _meta(_checksFor(styleErrors)));
            if (_notes) Object.assign(issue, { category: 'code-tokens', severity: 'low' });
            results.push(issue);
          }
        } else {
          // Values match - check if CSS design token variables are actually being used
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
              results.push({ type: 'TOKEN_PASS', element: elName, figmaNodeId: design.id || null });
            } else if (seenElements.has('note_' + elKey)) {
              // Same element already has a note (e.g. a button and its label): merge
              const existing = results[seenElements.get('note_' + elKey)];
              cssPropsToCheck.forEach(p => { if (!existing.details.includes(p.label)) existing.details.push(p.label); });
            } else {
              seenElements.set('note_' + elKey, results.length);
              // Not a mismatch: the values are right, but the code uses fixed values
              // instead of design tokens. Its own category, hidden by default.
              results.push(Object.assign({
                type: 'TOKEN_UNCONNECTED',
                element: elName,
                details: cssPropsToCheck.map(p => p.label),
                rect: ucRect
              }, _locator, { category: 'code-tokens', severity: 'low', selector: selectorBrowser(el), text: _elText, checks: [] }));
            }
          } else {
            results.push({ type: 'TOKEN_PASS', element: elName, figmaNodeId: design.id || null });
          }
        }
      };
      tokens.forEach(design => checkToken(design, 1, { x: 0, y: 0 }));
      // Pass 2 - layout shift: a section higher up that is 8px shorter moves everything
      // below it, so their design boxes land on the wrong elements. Retry each deferred
      // layer at the live offset of the smallest found layer that contains it in the
      // design. Largest first, so a card found here passes its offset on to its children.
      const _contains = (o, d) => o.x <= (d.x || 0) + 1 && o.y <= (d.y || 0) + 1 &&
        o.x + o.w >= (d.x || 0) + (d.w || 0) - 1 && o.y + o.h >= (d.y || 0) + (d.h || 0) - 1;
      _deferred.sort((a, b) => (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0)).forEach(design => {
        const parent = _matched.filter(m => !m.loose && _contains(m, design)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
        checkToken(design, 2, parent ? { x: parent.ox, y: parent.oy } : { x: 0, y: 0 });
      });
      const _pageRect = (r) => ({ x: Math.round(r.left + (window.scrollX || 0)), y: Math.round(r.top + (window.scrollY || 0)),
        w: Math.round(r.width), h: Math.round(r.height) });
      const _sevFor = (n, base) => n <= 2 ? 'low' : (n > 8 || (base > 0 && n / base > 0.25)) ? 'high' : 'medium';
      // Report the shift once, where it starts: a layer whose height differs from the
      // design when the next layer below it (same parent) moved by that same amount.
      // Everything further down is the knock-on effect, not a separate issue.
      try {
        const _area = d => (d.w || 0) * (d.h || 0);
        const _found = new Map();
        _matched.forEach(m => { if (!_found.has(m.design) && !m.loose) _found.set(m.design, m); });
        const _parent = new Map();
        _found.forEach((m, d) => _parent.set(d, tokens.filter(t => t !== d && _area(t) > _area(d) && _contains(t, d))
          .sort((a, b) => _area(a) - _area(b))[0]));
        _found.forEach((a, d) => {
          // Matched on its content's extent (glyphs), not a box: that height means nothing
          if (a.byContent) return;
          const dh = Math.round(a.live.height - a.h);
          if (Math.abs(dh) <= 2) return;
          let below = null;
          _found.forEach((b, bd) => {
            if (b === a || b.y < a.y + a.h - 1 || b.x >= a.x + a.w || b.x + b.w <= a.x || _parent.get(bd) !== _parent.get(d)) return;
            if (!below || b.y < below.y) below = b;
          });
          if (!below || Math.abs(Math.round(below.oy - a.oy) - dh) > 2) return;
          const n = Math.abs(dh), name = d.inst || d.name || 'Element';
          results.push({
            type: 'LAYOUT_SHIFT',
            element: name,
            details: [`Height: ${name} is ${n}px ${dh < 0 ? 'shorter' : 'taller'} than the design (${Math.round(a.h)} → ${Math.round(a.live.height)}px), so everything below it moves ${dh < 0 ? 'up' : 'down'} ${n}px`],
            rect: _pageRect(a.live),
            name, section: d.section || null, figmaNodeId: d.id || null,
            category: 'layout', severity: _sevFor(n, a.h), selector: selectorBrowser(a.el), text: null,
            checks: [{ prop: 'height', label: 'Height', category: 'layout', design: Math.round(a.h), live: Math.round(a.live.height),
              unit: 'px', diff: dh, small: false, severity: _sevFor(n, a.h), confidence: 'measured' }]
          });
        });
      } catch (e) {}
      // Position (Beta): a box that sits somewhere else inside its parent than the
      // design says, once the parent's own offset is removed. Suppressed when the move is
      // a knock-on of something already reported: the element or its parent changed size,
      // the parent's gap/padding is off, or a sibling before it resized or is missing.
      try {
        const _boxes = _matched.filter(m => !m.byContent && !m.loose && !(m.design.role === 'text' || m.design.fs));
        const _med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
        const gx = _med(_matched.map(m => m.ox)), gy = _med(_matched.map(m => m.oy));
        const _areaM = m => m.w * m.h;
        const _resized = m => Math.abs(m.live.width - m.w) > 2 || Math.abs(m.live.height - m.h) > 2;
        const _parentOf = new Map();
        _matched.forEach(m => _parentOf.set(m, _matched.filter(p => p !== m && !p.loose && _areaM(p) > _areaM(m) && _contains(p, m.design))
          .sort((a, b) => _areaM(a) - _areaM(b))[0] || null));
        const _missingRects = results.filter(r => r.element === 'Missing Element').map(r => r.rect);
        const _seenEls = new Set();
        for (const m of _boxes) {
          if (_seenEls.has(m.el) || _resized(m)) continue;
          _seenEls.add(m.el);
          const p = _parentOf.get(m);
          if (p && (_resized(p) || [...(_failedBy.get(p.design) || [])].some(l => /^(Gap|Padding)/.test(l)))) continue;
          const rx = Math.round(m.ox - (p ? p.ox : gx)), ry = Math.round(m.oy - (p ? p.oy : gy));
          if (Math.abs(rx) <= 2 && Math.abs(ry) <= 2) continue;
          const _before = o => (o.y + o.h <= m.y + 1 && o.x < m.x + m.w && o.x + o.w > m.x) ||
            (o.x + o.w <= m.x + 1 && o.y < m.y + m.h && o.y + o.h > m.y);
          const inParent = o => !p || _contains(p, o.design || { x: o.x, y: o.y, w: o.w, h: o.h });
          if (_matched.some(o => o !== m && _parentOf.get(o) === p && _before(o) && _resized(o))) continue;
          // Pinned to a bigger box that changed size (a badge on a card's corner)
          if (_matched.some(o => o !== m && o !== p && _areaM(o) > _areaM(m) && _resized(o) &&
            o.x < m.x + m.w && o.x + o.w > m.x && o.y < m.y + m.h && o.y + o.h > m.y)) continue;
          if (_missingRects.some(r => inParent({ x: r.x, y: r.y, w: r.w, h: r.h }) && _before(r))) continue;
          const name = m.design.inst || m.design.name || 'Element';
          const moves = [];
          if (Math.abs(rx) > 2) moves.push(`${Math.abs(rx)}px ${rx > 0 ? 'right' : 'left'}`);
          if (Math.abs(ry) > 2) moves.push(`${Math.abs(ry)}px ${ry > 0 ? 'lower' : 'higher'}`);
          const n = Math.max(Math.abs(rx), Math.abs(ry));
          const sev = n > 8 ? 'high' : 'medium';
          const dx = m.x + (p ? p.ox : gx), dy = m.y + (p ? p.oy : gy);
          results.push({
            type: 'LAYOUT_SHIFT',
            element: name,
            details: [`Position: ${moves.join(', ')} than the design`],
            rect: _pageRect(m.live),
            name, section: m.design.section || null, figmaNodeId: m.design.id || null,
            category: 'layout', severity: sev, selector: selectorBrowser(m.el), text: null,
            checks: [{ prop: 'position', label: 'Position', category: 'layout',
              design: { x: Math.round(dx), y: Math.round(dy) }, live: { x: Math.round(m.live.left), y: Math.round(m.live.top) },
              unit: 'px', diff: { x: rx, y: ry }, small: false, severity: sev, confidence: 'estimated' }]
          });
        }
      } catch (e) {}
      // A missing card also leaves its title, body and link missing: report the card once
      const _missing = results.filter(r => r.type === 'LAYOUT_SHIFT' && r.element === 'Missing Element');
      const _inside = (a, b) => a !== b && a.x >= b.x - 2 && a.y >= b.y - 2 &&
        a.x + a.w <= b.x + b.w + 2 && a.y + a.h <= b.y + b.h + 2;
      // (two layers with the same box: keep the first)
      const _folded = new Set(_missing.filter((m, i) => _missing.some((o, j) =>
        _inside(m.rect, o.rect) && (!_inside(o.rect, m.rect) || j < i))));
      // Put hidden overlays back exactly as they were
      _hiddenOverlays.forEach(([n, v, prio]) => {
        try { if (v) n.style.setProperty('visibility', v, prio); else n.style.removeProperty('visibility'); } catch (e) {}
      });
      try { window.__shadowScore = _shadow; } catch (e) {}
      return _folded.size ? results.filter(r => !_folded.has(r)) : results;
}

if (typeof module !== "undefined" && module.exports) module.exports = { probePage };
