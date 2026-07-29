/**
 * HTML → ReplicaSpec extractor.
 *
 * Loads an HTML file / URL / raw HTML string in headless Chromium (Playwright,
 * same rendering layer as render.ts), walks the live DOM, and converts every
 * visible element into the ReplicaSpec schema consumed by `import_html_replica`.
 *
 * Element mapping rules (DOM → spec):
 *  - `<img>`                    → type 'image', asset with resolved absolute URL
 *                                 (relative src resolved against the document
 *                                 base; data: URLs kept as-is).
 *  - `<svg>`                    → rasterized in-page to a transparent PNG at
 *                                 `rasterScale`× (default 2x) the display size
 *                                 (XMLSerializer → Blob → Image → canvas), so
 *                                 icons import as REAL images; type 'image',
 *                                 original vector markup kept in
 *                                 asset.vectorUrl. With rasterizeSvg:false (or
 *                                 on raster failure) it degrades to type 'svg'
 *                                 + a data:image/svg+xml asset (importer warns
 *                                 and places a placeholder).
 *  - `<img src="*.svg">`        → same rasterization (canvas drawImage of the
 *                                 loaded bitmap); vector URL in vectorUrl.
 *  - leaf element with own text → type 'text' (any tag; a div with direct text
 *                                 and no element children is text).
 *  - leaf element without text  → type 'frame' (a visual box: background /
 *                                 border / shadow / radius, or a transparent
 *                                 placeholder container).
 *  - element with children      → type 'frame' container; children recurse via
 *                                 the nested `children` field with page-absolute
 *                                 rects (importer converts to parent-relative).
 *  - container with own text AND a visible box (button/input-like) → 'frame'
 *                                 with a synthetic trailing text child spanning
 *                                 the container rect (text alignment preserved).
 *  - leaf with background-image: url(...) → type 'image' with that URL.
 *  - hidden elements (display:none, visibility:hidden/collapse, opacity:0,
 *    zero-size) are skipped, along with script/style/noscript/template/head.
 *    Broken <img>s, 1×1 tracking pixels, tracker hosts (DEFAULT_TRACKER_HOST_PATTERN),
 *    and — unless includeHidden — elements fully clipped by an overflow
 *    ancestor or entirely off-canvas (hidden carousel slides) are also pruned.
 *  - createImage-incompatible raster formats (webp/avif/heic/…) are rasterized
 *    in-page to 2x PNGs (canvas drawImage); the original URL is kept in
 *    asset.originalUrl as the importer's fallback.
 *  - elements whose subtree is pure inline formatting (span/b/strong/a/em/…)
 *    merge into ONE text element with styled `runs` (per-run font/weight/color;
 *    run-boundary whitespace preserved). Style-less single-child container
 *    chains collapse and style-less empty leaf frames are dropped
 *    (collapseContainers, default on).
 *
 * Style mapping (computed CSS → SpecStyle):
 *  - color/backgroundColor      → hex + alpha (transparent backgrounds omitted)
 *  - backgroundImage gradient   → kept as CSS string (linear-gradient only)
 *  - border-radius              → number, or [topLeft, topRight, bottomRight,
 *                                 bottomLeft]; percentage radii approximate to
 *                                 pct * min(width, height)
 *  - border (uniform, solid)    → style.border { color, width, style };
 *                                 non-uniform borders degrade to the widest
 *                                 side + a warning
 *  - box-shadow                 → kept as CSS string (importer parses inset /
 *                                 offsets / blur / spread / color)
 *  - font-family                → first family; generic CSS families
 *                                 (-apple-system, system-ui, sans-serif, …)
 *                                 map to 'Inter'
 *  - font-weight/size, line-height (px), letter-spacing (px), text-align,
 *    text-transform, opacity    → passed through numerically where possible
 *
 * Sections: by default the whole page is ONE section rooted at `rootSelector`
 * (default body) — HTML replicas are usually a single screen. Pass
 * `sectionSelector` to split the page into one section per matched element
 * (nested matches collapse to the outermost). The page background (body wins
 * over html, per CSS canvas propagation; solid or gradient) moves to
 * spec.canvas.background/backgroundImage and becomes the main frame fill.
 *
 * Text elements carry a `textAutoResize` hint: single-line (measured lines <
 * 1.6, or white-space != normal) → 'WIDTH_AND_HEIGHT' so Figma sizes to
 * content instead of wrapping a Chromium-measured fixed width; multi-line →
 * 'HEIGHT' (fixed width, wrapping preserved).
 *
 * Webfont families seen by document.fonts are recorded in
 * spec.metadata.options.webfonts for downstream font mapping.
 */

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, openPage, type RenderOptions, type Viewport } from './render';
import { parseCssColor } from './css';
import type { ReplicaAsset, ReplicaElement, ReplicaSection, ReplicaSpec, SpecStyle, SpecTextRun } from './spec';

export interface ExtractHtmlSpecOptions extends RenderOptions {
  /** CSS selector for the replica root (default 'body'). */
  rootSelector?: string;
  /** CSS selector splitting the page into multiple sections (default: single section). */
  sectionSelector?: string;
  /** Frame/spec name (default: document title or the HTML file basename). */
  name?: string;
  /** Rasterize inline <svg> and <img src="*.svg"> to transparent PNGs (default true). */
  rasterizeSvg?: boolean;
  /** Rasterize raster images figma.createImage can't ingest (webp/avif/heic/…) to 2x PNGs (default true). */
  rasterizeRaster?: boolean;
  /** Raster scale factor vs display size (default 2, retina). */
  rasterScale?: number;
  /**
   * Keep elements that are off-canvas or fully clipped by an overflow:hidden
   * ancestor (e.g. hidden carousel slides). Default false: they are pruned.
   * display:none / visibility:hidden / opacity:0 are always skipped.
   */
  includeHidden?: boolean;
  /**
   * Regex source matched against an <img>'s hostname; matches are dropped as
   * trackers (default: DEFAULT_TRACKER_HOST_PATTERN). Pass null to disable.
   */
  trackerPattern?: string | null;
  /** Process-local extraction cache (5 min TTL, keyed by url or htmlPath+mtime+viewport). Default true. */
  cache?: boolean;
}

/**
 * Default tracker/analytics host filter (item: skip tracker pixels). Hostname
 * regex source; override via ExtractHtmlSpecOptions.trackerPattern.
 */
export const DEFAULT_TRACKER_HOST_PATTERN =
  '(^|\\.)doubleclick\\.net$|(^|\\.)bat\\.bing\\.com$|(^|\\.)analytics\\.twitter\\.com$|(^|\\.)fls\\.[a-z.]+|\\.fls\\.|(^|\\.)google-analytics\\.com$|(^|\\.)googletagmanager\\.com$|(^|\\.)connect\\.facebook\\.net$|(^|\\.)facebook\\.com$|(^|\\.)pixel\\.[^.]+\\.|(^|\\.)beacon\\.[^.]+\\.';

export interface ExtractHtmlSpecResult {
  spec: ReplicaSpec;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Raw DOM tree (produced inside the page, JSON-serializable)
// ---------------------------------------------------------------------------

export interface RawTextRun {
  /** Run text; internal whitespace collapsed to single spaces, boundary spaces preserved. */
  text: string;
  style: {
    color?: string;
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
    fontSize?: string;
  };
}

export interface RawDomNode {
  tag: string;
  id?: string;
  className?: string;
  /** Direct text-node content (element children excluded), whitespace-collapsed. */
  text?: string;
  /**
   * Measured bounding box of the element's own text (DOM Range union of the
   * direct text nodes, page-absolute). Only set in-browser when the element
   * carries own text; lets the synthetic label of a button-like box use the
   * real glyph span instead of the whole container rect.
   */
  textRect?: { x: number; y: number; width: number; height: number };
  rect: { x: number; y: number; width: number; height: number };
  src?: string;
  svg?: string;
  /** Rasterized PNG data URL (2x) for SVG content — inline <svg> and <img src="*.svg">. */
  rasterPng?: string;
  /** What rasterPng was produced from: svg content or a createImage-incompatible raster (webp/avif/…). */
  rasterSource?: 'svg' | 'svg-img' | 'raster-img';
  imgBroken?: boolean;
  overflow?: string;
  /** Merged styled runs for pure inline-formatting text blocks (span/b/strong/a/em/…). */
  runs?: RawTextRun[];
  style: {
    color?: string;
    backgroundColor?: string;
    backgroundImage?: string;
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    fontStyle?: string;
    lineHeight?: string;
    letterSpacing?: string;
    textAlign?: string;
    textTransform?: string;
    whiteSpace?: string;
    opacity?: string;
    borderRadius?: [string, string, string, string];
    borderWidth?: [string, string, string, string];
    borderColor?: [string, string, string, string];
    borderStyle?: [string, string, string, string];
    boxShadow?: string;
  };
  children: RawDomNode[];
}

export interface RawDomSection {
  root: RawDomNode;
}

export interface RawDomResult {
  viewport: Viewport;
  pageHeight: number;
  fonts: string[];
  warnings: string[];
  /** Computed page background candidates (CSS canvas propagation: body wins over html). */
  pageBackground: { body: { color?: string; image?: string }; html: { color?: string; image?: string } };
  sections: RawDomSection[];
}

// ---------------------------------------------------------------------------
// In-page extraction
// ---------------------------------------------------------------------------

async function extractRawDom(
  opts: ExtractHtmlSpecOptions,
): Promise<{ raw: RawDomResult; title: string }> {
  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, opts);
    const params = {
      rootSelector: opts.rootSelector ?? 'body',
      sectionSelector: opts.sectionSelector ?? null,
      rasterizeSvg: opts.rasterizeSvg !== false,
      rasterizeRaster: opts.rasterizeRaster !== false,
      rasterScale: opts.rasterScale ?? 2,
      includeHidden: opts.includeHidden === true,
      trackerPattern: opts.trackerPattern === null ? null : (opts.trackerPattern ?? DEFAULT_TRACKER_HOST_PATTERN),
    };
    const raw = await page.evaluate(async (p) => {
      const warnings: string[] = [];
      // Skeleton detection: a JS-rendered page whose hydration was blocked
      // (bot protection 403ing the app's API/JS) leaves almost no text.
      // Extraction still succeeds — warn so callers don't trust the result.
      if (document.readyState !== 'complete') {
        warnings.push(
          `page never reached readyState=complete (got "${document.readyState}") — ` +
            'the site may be bot-protected or slow; the result may be an unhydrated skeleton. ' +
            'Workaround: save the rendered HTML from a real browser session and use htmlPath.',
        );
      }
      const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'br']);
      // Elements whose content should be rasterized to PNG (retina).
      const rasterQueue: Array<{ node: Record<string, unknown>; el: Element; kind: 'svg' | 'svg-img' | 'raster-img' }> = [];
      const trackerRe = p.trackerPattern ? new RegExp(p.trackerPattern, 'i') : null;
      // Raster formats figma.createImage cannot ingest → extraction-side canvas rasterization.
      const NON_CREATEIMAGE_RE = /\.(webp|avif|heic|heif|jxl|bmp|tiff?|ico)(\?|#|$)|^data:image\/(webp|avif|heic|heif|jxl|bmp|tiff|x-icon|vnd\.microsoft\.icon)/i;
      // Inline formatting tags: an element whose subtree consists only of these
      // (plus text) merges into ONE text element with styled runs.
      const INLINE_FMT = new Set([
        'span', 'b', 'strong', 'a', 'em', 'i', 'u', 's', 'strike', 'small', 'mark', 'abbr',
        'cite', 'code', 'q', 'sub', 'sup', 'font', 'time', 'data', 'del', 'ins', 'kbd', 'samp', 'var', 'dfn', 'bdi', 'bdo',
      ]);

      function hostOf(url: string): string {
        try {
          return new URL(url, document.baseURI).hostname;
        } catch {
          return '';
        }
      }

      function isInlineTree(el: Element): boolean {
        for (const child of Array.from(el.children)) {
          if (!INLINE_FMT.has(child.tagName.toLowerCase())) return false;
          if (!isInlineTree(child)) return false;
        }
        return true;
      }

      /** DFS over text nodes; each run carries the computed style of its deepest inline element. */
      function collectRuns(el: Element, out: Array<{ text: string; style: Record<string, string> }>) {
        el.childNodes.forEach((n) => {
          if (n.nodeType === 3) {
            const t = (n.nodeValue ?? '').replace(/\s+/g, ' ');
            if (!t) return;
            const cs = getComputedStyle(el);
            out.push({
              text: t,
              style: { color: cs.color, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, fontSize: cs.fontSize },
            });
          } else if (n.nodeType === 1) {
            const child = n as Element;
            const cs = getComputedStyle(child);
            if (cs.display === 'none' || cs.visibility === 'hidden') return;
            collectRuns(child, out);
          }
        });
      }

      /** Merge adjacent runs with identical styles; trim boundary whitespace; drop empties. */
      function normalizeRuns(runs: Array<{ text: string; style: Record<string, string> }>) {
        const sig = (s: Record<string, string>) => [s.color, s.fontFamily, s.fontWeight, s.fontStyle, s.fontSize].join('|');
        const merged: Array<{ text: string; style: Record<string, string> }> = [];
        for (const r of runs) {
          const last = merged[merged.length - 1];
          if (last && sig(last.style) === sig(r.style)) last.text += r.text;
          else merged.push({ ...r });
        }
        if (merged.length) {
          merged[0].text = merged[0].text.replace(/^\s+/, '');
          merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, '');
        }
        return merged.filter((r) => r.text.length > 0);
      }

      function rectOf(el: Element) {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }

      function ownText(el: Element): string {
        let t = '';
        el.childNodes.forEach((n) => {
          if (n.nodeType === 3) t += n.nodeValue;
        });
        return t.replace(/\s+/g, ' ').trim();
      }

      function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
        return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      }

      function walk(el: Element, clip: { x: number; y: number; width: number; height: number } | null): unknown | null {
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return null;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return null;
        if (parseFloat(cs.opacity) === 0) return null;
        if ((el as HTMLElement).hasAttribute?.('data-figmingo-hidden')) return null;
        const rect = rectOf(el);
        if (!p.includeHidden) {
          // Fully clipped by an overflow:hidden/scroll/auto ancestor (hidden
          // carousel slides) or off-canvas entirely — contributes nothing.
          if (clip && !intersects(rect, clip)) return null;
          const vw = window.innerWidth;
          if (rect.x + rect.width < 0 || rect.x > vw || rect.y + rect.height < 0) return null;
        }
        // An overflow-clipping ancestor narrows the clip box for its descendants.
        let childClip = clip;
        if (/(hidden|scroll|auto|clip)/.test(`${cs.overflow} ${cs.overflowX} ${cs.overflowY}`)) {
          childClip = clip && !intersects(clip, rect) ? clip : clip ? {
            x: Math.max(clip.x, rect.x),
            y: Math.max(clip.y, rect.y),
            width: Math.min(clip.x + clip.width, rect.x + rect.width) - Math.max(clip.x, rect.x),
            height: Math.min(clip.y + clip.height, rect.y + rect.height) - Math.max(clip.y, rect.y),
          } : rect;
        }
        // Merged styled-runs path: element whose element children are ALL inline
        // formatting tags (span/b/strong/a/em/…) collapses into one text block.
        const mergeRuns = el.children.length > 0 && tag !== 'img' && tag !== 'svg' && isInlineTree(el);
        const children: unknown[] = [];
        let runs: Array<{ text: string; style: Record<string, string> }> | undefined;
        let text = '';
        if (mergeRuns) {
          const raw: Array<{ text: string; style: Record<string, string> }> = [];
          collectRuns(el, raw);
          const merged = normalizeRuns(raw);
          if (merged.length >= 2) {
            runs = merged;
            text = merged.map((r) => r.text).join('');
          } else {
            text = merged.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
          }
        } else {
          for (const child of Array.from(el.children)) {
            const c = walk(child, childClip);
            if (c) children.push(c);
          }
          text = ownText(el);
        }
        // Measure the actual glyph span of the element's own text (union of
        // DOM Range rects). Button-like boxes get a synthetic label child —
        // sizing that label from the real text span (instead of the whole
        // container rect) keeps the label positioned/wrapped like the browser
        // (a full-width box misreads as multi-line and top-anchors the label).
        let textRect: { x: number; y: number; width: number; height: number } | undefined;
        if (text) {
          try {
            let x0 = Infinity;
            let y0 = Infinity;
            let x1 = -Infinity;
            let y1 = -Infinity;
            const eat = (r: { left: number; top: number; right: number; bottom: number; width: number; height: number }) => {
              if (r.width < 1 || r.height < 1) return;
              x0 = Math.min(x0, r.left + window.scrollX);
              y0 = Math.min(y0, r.top + window.scrollY);
              x1 = Math.max(x1, r.right + window.scrollX);
              y1 = Math.max(y1, r.bottom + window.scrollY);
            };
            if (mergeRuns) {
              // Pure inline-formatting subtree: the whole contents IS the text.
              const range = document.createRange();
              range.selectNodeContents(el);
              Array.from(range.getClientRects()).forEach(eat);
            } else {
              // Mixed content (e.g. icon + label): only the direct text nodes.
              el.childNodes.forEach((n) => {
                if (n.nodeType === 3 && (n.nodeValue ?? '').trim()) {
                  const range = document.createRange();
                  range.selectNode(n);
                  Array.from(range.getClientRects()).forEach(eat);
                }
              });
            }
            if (x1 > x0 && y1 > y0) {
              textRect = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
            }
          } catch {
            /* Range measurement is best-effort; the container rect is the fallback */
          }
        }
        if (rect.width < 1 || rect.height < 1) {
          // Zero-size elements only survive if they carry visible descendants.
          if (!children.length && !text) return null;
        }
        const node: Record<string, unknown> = {
          tag,
          id: el.id || undefined,
          // getAttribute('class') works for SVG too (className is an
          // SVGAnimatedString there, not a plain string).
          className: el.getAttribute('class') || undefined,
          rect,
          text: text || undefined,
          textRect,
          runs,
          overflow: cs.overflow,
          style: {
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            backgroundImage: cs.backgroundImage,
            fontFamily: cs.fontFamily,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle,
            lineHeight: cs.lineHeight,
            letterSpacing: cs.letterSpacing,
            textAlign: cs.textAlign,
            textTransform: cs.textTransform,
            whiteSpace: cs.whiteSpace,
            opacity: cs.opacity,
            borderRadius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
            borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
            borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
            borderStyle: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
            boxShadow: cs.boxShadow,
          },
          children,
        };
        if (tag === 'img') {
          const img = el as HTMLImageElement;
          const src = img.currentSrc || img.src || '';
          // Tracker hosts are dropped before anything else (deterministic even
          // when the request itself fails offline).
          if (trackerRe && trackerRe.test(hostOf(src))) return null; // tracker host
          // Broken images and tracker pixels produce no element at all.
          if (!img.complete || img.naturalWidth === 0) {
            node.imgBroken = true;
            warnings.push(`img failed to load: ${src || '(no src)'}`);
            return null;
          }
          if (img.naturalWidth < 2 && img.naturalHeight < 2 && rect.width < 2 && rect.height < 2) return null; // tracking pixel (1×1, displayed 1×1)
          node.src = src || undefined;
          if (p.rasterizeSvg && /\.svg(\?|#|$)/i.test(src)) {
            rasterQueue.push({ node, el, kind: 'svg-img' });
            node.rasterSource = 'svg-img';
          } else if (p.rasterizeRaster && NON_CREATEIMAGE_RE.test(src)) {
            rasterQueue.push({ node, el, kind: 'raster-img' });
            node.rasterSource = 'raster-img';
          }
        }
        if (tag === 'svg') {
          node.svg = el.outerHTML;
          if (p.rasterizeSvg) {
            rasterQueue.push({ node, el, kind: 'svg' });
            node.rasterSource = 'svg';
          }
        }
        return node;
      }

      /** Draw an SVG (markup string) into a transparent canvas at `scale`× the display size. */
      async function rasterizeMarkup(markup: string, dispW: number, dispH: number, scale: number): Promise<string> {
        const w = Math.max(1, Math.round(dispW * scale));
        const h = Math.max(1, Math.round(dispH * scale));
        let src = markup;
        if (!src.includes('xmlns=')) src = src.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
        // Force explicit pixel size so the raster is not tied to viewBox units.
        src = src.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
          const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, '');
          return `<svg${cleaned} width="${w}" height="${h}">`;
        });
        const url = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml;charset=utf-8' }));
        try {
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('svg image decode failed'));
            img.src = url;
          });
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL('image/png');
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      const rootEl = document.querySelector(p.rootSelector);
      if (!rootEl) throw new Error(`extractHtmlSpec: root selector matched nothing: ${p.rootSelector}`);

      let sectionRoots: Element[] = [rootEl];
      if (p.sectionSelector) {
        const all = Array.from(rootEl.querySelectorAll(p.sectionSelector));
        const matched = rootEl.matches(p.sectionSelector) ? [rootEl, ...all] : all;
        // Outermost matches only — a section inside a section collapses upward.
        sectionRoots = matched.filter((el) => !matched.some((other) => other !== el && other.contains(el)));
        if (!sectionRoots.length) warnings.push(`sectionSelector matched nothing: ${p.sectionSelector}; fell back to single section`);
        if (!sectionRoots.length) sectionRoots = [rootEl];
      }

      const sections = sectionRoots
        .map((root) => {
          const r = walk(root, null);
          return r ? { root: r } : null;
        })
        .filter(Boolean);

      // Rasterize queued content (2x, transparent PNG). Failures keep the
      // original asset and degrade to the importer's fallback chain + warning.
      for (const item of rasterQueue) {
        try {
          const r = item.node.rect as { width: number; height: number };
          if (item.kind === 'svg-img' || item.kind === 'raster-img') {
            // <img> content: draw the already-loaded bitmap directly.
            const img = item.el as HTMLImageElement;
            const w = Math.max(1, Math.round(r.width * p.rasterScale));
            const h = Math.max(1, Math.round(r.height * p.rasterScale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
            item.node.rasterPng = canvas.toDataURL('image/png');
          } else {
            const markup = String(item.node.svg ?? '');
            if (markup) item.node.rasterPng = await rasterizeMarkup(markup, r.width, r.height, p.rasterScale);
          }
        } catch (err) {
          warnings.push(
            `rasterize failed for "${item.node.id ?? item.node.className ?? item.kind}": ${(err as Error).message}`,
          );
        }
      }

      const fonts: string[] = [];
      try {
        (document as Document & { fonts?: { forEach?: (cb: (f: { family: string; status: string }) => void) => void } }).fonts?.forEach?.(
          (f) => {
            if (f.status === 'loaded') fonts.push(f.family.replace(/['"]/g, ''));
          },
        );
      } catch {
        /* document.fonts unavailable */
      }

      const bgOf = (el: Element | null) => {
        if (!el) return {};
        const cs = getComputedStyle(el);
        return { color: cs.backgroundColor, image: cs.backgroundImage };
      };

      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        pageHeight: Math.round(document.documentElement.scrollHeight),
        fonts: Array.from(new Set(fonts)),
        warnings,
        pageBackground: { body: bgOf(document.body), html: bgOf(document.documentElement) },
        sections,
      };
    }, params);
    return { raw: raw as RawDomResult, title: await page.title() };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Raw DOM → ReplicaSpec (pure, unit-testable without a browser)
// ---------------------------------------------------------------------------

const GENERIC_FAMILIES = new Set([
  '-apple-system',
  'system-ui',
  'blinkmacsystemfont',
  'sans-serif',
  'serif',
  'monospace',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'cursive',
  'fantasy',
  'emoji',
  'math',
  'fangsong',
]);

function mapFontFamily(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(',')[0].replace(/['"]/g, '').trim();
  if (!first) return undefined;
  if (GENERIC_FAMILIES.has(first.toLowerCase())) return 'Inter';
  return first;
}

function pxNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** One border-radius corner: px value, or % approximated against min(w,h). */
function radiusCorner(v: string | undefined, w: number, h: number): number {
  if (!v) return 0;
  const t = v.trim();
  if (t.endsWith('%')) return Math.round(((parseFloat(t) || 0) / 100) * Math.min(w, h));
  // Elliptical "X Y" form — take the horizontal component.
  const n = parseFloat(t.split(/\s+/)[0]);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function gradientFromBackgroundImage(v: string | undefined): string | undefined {
  if (!v || v === 'none') return undefined;
  const m = v.match(/linear-gradient\((?:[^()]|\([^()]*\))*\)/);
  return m ? m[0] : undefined;
}

function imageUrlFromBackground(v: string | undefined): string | undefined {
  if (!v || v === 'none') return undefined;
  const m = v.match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
  return m ? m[1] : undefined;
}

export interface DomToSpecOptions {
  name?: string;
  warnings?: string[];
  /**
   * Collapse style-less single-child container chains into their child and
   * drop style-less empty leaf frames (default true). Section roots are never
   * collapsed away.
   */
  collapseContainers?: boolean;
}

/** Visual-style check shared by container collapsing. */
function hasVisualStyle(style: SpecStyle): boolean {
  return (
    style.backgroundColor !== undefined ||
    style.backgroundImage !== undefined ||
    style.border !== undefined ||
    style.boxShadow !== undefined ||
    style.borderRadius !== undefined ||
    (style.opacity !== undefined && style.opacity < 1)
  );
}

/**
 * Post-pass over the element tree: merge a style-less frame that wraps exactly
 * one frame child into that child (chains collapse transitively), and drop
 * style-less leaf frames with no content. Clipping flags survive the merge.
 */
export function collapseReplicaContainers(root: ReplicaElement): ReplicaElement {
  const visit = (el: ReplicaElement): ReplicaElement | null => {
    if (el.type !== 'frame') return el;
    if (el.children) el.children = el.children.map(visit).filter((c): c is ReplicaElement => c !== null);
    if (!el.children?.length) {
      // Empty style-less leaf frame: dropped (unless it carries text — a label).
      return !el.text && !hasVisualStyle(el.style) ? null : el;
    }
    let out = el;
    while (
      out.type === 'frame' &&
      !out.text &&
      !hasVisualStyle(out.style) &&
      out.children?.length === 1 &&
      out.children[0].type === 'frame'
    ) {
      const child = out.children[0];
      child.clipsContent = child.clipsContent || out.clipsContent;
      child.key = out.key; // keep the outer (shallower) key for stable paths
      out = child;
    }
    return out;
  };
  if (root.children) root.children = root.children.map(visit).filter((c): c is ReplicaElement => c !== null);
  return root;
}

export function rawDomToReplicaSpec(raw: RawDomResult, opts: DomToSpecOptions = {}): ReplicaSpec {
  const warnings = opts.warnings ?? [];
  const assets: ReplicaAsset[] = [];
  let assetSeq = 0;
  let nodeSeq = 0;
  const nid = () => `h${nodeSeq++}`;

  const addAsset = (kind: 'image' | 'svg', url: string, fileName: string): ReplicaAsset => {
    const existing = assets.find((a) => a.url === url);
    if (existing) return existing;
    const asset: ReplicaAsset = { id: `a${assetSeq++}`, kind, nodeIds: [], url, fileName };
    assets.push(asset);
    return asset;
  };

  const fileNameFor = (url: string, fallback: string): string => {
    if (url.startsWith('data:')) return fallback;
    try {
      const base = url.startsWith('file:') ? url.slice('file://'.length) : new URL(url).pathname;
      const name = path.basename(decodeURIComponent(base));
      return name || fallback;
    } catch {
      return fallback;
    }
  };

  const styleOf = (node: RawDomNode, isText: boolean): SpecStyle => {
    const s = node.style;
    const out: SpecStyle = {};
    if (isText) {
      const color = parseCssColor(s.color);
      if (color?.hex) {
        out.color = color.hex;
        if (color.a < 1) out.colorAlpha = Math.round(color.a * 1000) / 1000;
      }
      out.fontFamily = mapFontFamily(s.fontFamily);
      const weight = parseInt(s.fontWeight ?? '', 10);
      if (Number.isFinite(weight)) out.fontWeight = weight;
      if (s.fontStyle === 'italic') out.fontStyleName = weight >= 700 ? 'Bold Italic' : weight === 400 || !Number.isFinite(weight) ? 'Italic' : undefined;
      const size = pxNum(s.fontSize);
      if (size) out.fontSize = size;
      if (s.lineHeight && s.lineHeight !== 'normal') {
        const lh = pxNum(s.lineHeight);
        if (lh) out.lineHeight = lh;
      }
      if (s.letterSpacing && s.letterSpacing !== 'normal') {
        const ls = pxNum(s.letterSpacing);
        if (ls) out.letterSpacing = ls;
      }
      if (s.textAlign) out.textAlign = s.textAlign;
      if (s.textTransform && s.textTransform !== 'none') out.textTransform = s.textTransform;
    } else {
      const bg = parseCssColor(s.backgroundColor);
      if (bg?.hex) {
        out.backgroundColor = bg.hex;
        if (bg.a < 1) out.backgroundAlpha = Math.round(bg.a * 1000) / 1000;
      }
      const grad = gradientFromBackgroundImage(s.backgroundImage);
      if (grad) out.backgroundImage = grad;
    }
    const opacity = parseFloat(s.opacity ?? '1');
    if (Number.isFinite(opacity) && opacity < 1) out.opacity = opacity;

    const [tl, tr, br, bl] = (s.borderRadius ?? []).map((v) => radiusCorner(v, node.rect.width, node.rect.height));
    if (tl || tr || br || bl) {
      out.borderRadius = tl === tr && tr === br && br === bl ? tl : [tl, tr, br, bl];
    }

    const widths = (s.borderWidth ?? []).map((v) => pxNum(v) ?? 0);
    const maxW = Math.max(...widths, 0);
    if (maxW > 0) {
      const uniform = widths.every((w) => Math.abs(w - maxW) < 0.01);
      const idx = widths.indexOf(maxW);
      const color = parseCssColor(s.borderColor?.[idx]);
      const bStyle = (s.borderStyle?.[idx] ?? 'solid') as 'solid' | 'dashed' | 'dotted';
      if (color?.hex) {
        out.border = { color: color.hex, width: Math.round(maxW * 100) / 100, style: bStyle === 'dashed' || bStyle === 'dotted' ? bStyle : 'solid' };
        if (color.a < 1) out.border.colorAlpha = Math.round(color.a * 1000) / 1000;
        if (!uniform) warnings.push(`non-uniform border on <${node.tag}> "${node.id ?? node.className ?? ''}": using ${maxW}px on all sides`);
      }
    }

    if (s.boxShadow && s.boxShadow !== 'none') out.boxShadow = s.boxShadow;
    return out;
  };

  /**
   * Single-line text gets WIDTH_AND_HEIGHT (Figma sizes to content — Chromium
   * vs Figma metric drift otherwise wraps fixed-width boxes); multi-line
   * paragraphs get HEIGHT (fixed width, wraps, height follows content).
   */
  const textAutoResizeFor = (node: RawDomNode): 'WIDTH_AND_HEIGHT' | 'HEIGHT' => {
    const fontSize = pxNum(node.style.fontSize) ?? 16;
    const lhRaw = node.style.lineHeight;
    const lh = lhRaw && lhRaw !== 'normal' ? pxNum(lhRaw) ?? fontSize * 1.2 : fontSize * 1.2;
    const ws = node.style.whiteSpace ?? 'normal';
    if (ws !== 'normal') return 'WIDTH_AND_HEIGHT';
    return node.rect.height / lh < 1.6 ? 'WIDTH_AND_HEIGHT' : 'HEIGHT';
  };

  /**
   * Map raw styled runs to spec runs. Returns undefined when every run's style
   * matches the element-level base style (uniform text → legacy single-font
   * path, backward compatible).
   */
  const mapRuns = (node: RawDomNode, base: SpecStyle): SpecTextRun[] | undefined => {
    if (!node.runs || node.runs.length < 2) return undefined;
    const runs: SpecTextRun[] = node.runs.map((r) => {
      const run: SpecTextRun = { text: r.text };
      const fam = mapFontFamily(r.style.fontFamily);
      if (fam) run.fontFamily = fam;
      const w = parseInt(r.style.fontWeight ?? '', 10);
      if (Number.isFinite(w)) run.fontWeight = w;
      if (r.style.fontStyle === 'italic') run.fontStyleName = 'Italic';
      const color = parseCssColor(r.style.color);
      if (color?.hex) {
        run.color = color.hex;
        if (color.a < 1) run.colorAlpha = Math.round(color.a * 1000) / 1000;
      }
      return run;
    });
    const same = (r: SpecTextRun) =>
      (r.fontFamily ?? base.fontFamily) === base.fontFamily &&
      (r.fontWeight ?? base.fontWeight) === base.fontWeight &&
      (r.fontStyleName ?? base.fontStyleName) === base.fontStyleName &&
      (r.color ?? base.color) === base.color &&
      (r.colorAlpha ?? base.colorAlpha) === base.colorAlpha;
    return runs.every(same) ? undefined : runs;
  };

  /**
   * Right-edge anchor detection (Bug: right-aligned texts clipped after font
   * fallback). A text whose right edge is flush with its parent's right edge
   * (≤4px) is right-anchored in the source layout; with WIDTH_AND_HEIGHT the
   * Figma box would grow rightward past the container and get clipped, so the
   * importer/plugin re-anchor its x. Center-aligned labels and texts spanning
   * nearly the full parent width (synthetic button labels) are excluded — for
   * those the anchor is the center, not the right edge.
   */
  const anchorRightFor = (node: RawDomNode, parentNode: RawDomNode | undefined, autoResize: string): boolean | undefined => {
    if (autoResize !== 'WIDTH_AND_HEIGHT' || !parentNode) return undefined;
    const align = node.style.textAlign;
    if (align === 'center' || align === 'middle') return undefined;
    const pr = parentNode.rect;
    if (pr.width < 1 || node.rect.width >= pr.width * 0.9) return undefined;
    const rightGap = pr.x + pr.width - (node.rect.x + node.rect.width);
    return rightGap >= -4 && rightGap <= 4 ? true : undefined;
  };

  const elementFor = (node: RawDomNode, parentKey: string, parentNode?: RawDomNode): ReplicaElement | null => {
    const id = nid();
    const key = parentKey ? `${parentKey}/${node.tag}` : node.tag;
    const name = node.id || (node.className ? String(node.className).split(/\s+/)[0] : node.tag);
    const base: ReplicaElement = {
      key,
      nodeId: id,
      name,
      type: 'frame',
      rect: node.rect,
      style: {},
    };

    if (node.tag === 'img') {
      base.type = 'image';
      base.style = styleOf(node, false);
      if (node.rasterPng) {
        // Rasterized at extraction (2x PNG): svg-img keeps the vector source in
        // vectorUrl; raster-img (webp/avif/…) keeps the original bytes URL in
        // originalUrl as the importer's fallback.
        const asset = addAsset('image', node.rasterPng, fileNameFor(node.src ?? '', `${name}.png`).replace(/\.[a-z0-9]+$/i, '.png'));
        if (node.rasterSource === 'raster-img') asset.originalUrl ??= node.src;
        else asset.vectorUrl ??= node.src;
        base.assetId = asset.id;
      } else if (node.src) {
        const asset = addAsset('image', node.src, fileNameFor(node.src, `${name}.png`));
        base.assetId = asset.id;
      }
      if (/logo/i.test(name)) base.assetHint = 'logo';
      else if (/icon|ic[_-]/i.test(name)) base.assetHint = 'icon';
      return base;
    }

    if (node.tag === 'svg') {
      base.assetHint = 'icon';
      if (node.rasterPng) {
        // Inline SVG rasterized to a transparent PNG at 2x: real image into
        // Figma; the original vector markup stays in asset.vectorUrl.
        base.type = 'image';
        base.style = styleOf(node, false);
        const asset = addAsset('image', node.rasterPng, `${name}.png`);
        if (node.svg) asset.vectorUrl ??= `data:image/svg+xml;utf8,${encodeURIComponent(node.svg)}`;
        base.assetId = asset.id;
        return base;
      }
      base.type = 'svg';
      if (node.svg) {
        const url = `data:image/svg+xml;utf8,${encodeURIComponent(node.svg)}`;
        const asset = addAsset('svg', url, `${name}.svg`);
        base.assetId = asset.id;
      }
      return base;
    }

    const kids = node.children.map((c) => elementFor(c, key, node)).filter((c): c is ReplicaElement => c !== null);
    const bgImageUrl = imageUrlFromBackground(node.style.backgroundImage);
    const hasBox =
      !!parseCssColor(node.style.backgroundColor) ||
      !!gradientFromBackgroundImage(node.style.backgroundImage) ||
      (node.style.borderWidth ?? []).some((w) => (pxNum(w) ?? 0) > 0) ||
      (!!node.style.boxShadow && node.style.boxShadow !== 'none');

    if (!kids.length && !node.text && bgImageUrl) {
      base.type = 'image';
      base.style = styleOf(node, false);
      const asset = addAsset('image', bgImageUrl, fileNameFor(bgImageUrl, `${name}.png`));
      base.assetId = asset.id;
      return base;
    }

    if (!kids.length && node.text) {
      if (!hasBox) {
        base.type = 'text';
        base.text = node.text;
        base.style = styleOf(node, true);
        base.runs = mapRuns(node, base.style);
        base.textAutoResize = textAutoResizeFor(node);
        base.anchorRight = anchorRightFor(node, parentNode, base.textAutoResize);
        return base;
      }
      // Button/input-like: visible box + label → frame with synthetic text child.
      // The label uses the MEASURED text span (textRect) when available: the
      // full container rect would misread as multi-line (box height ÷ line
      // height) and top-anchor the label inside the button.
      base.type = 'frame';
      base.style = styleOf(node, false);
      const textStyle = styleOf(node, true);
      const labelRect = node.textRect ?? node.rect;
      base.children = [
        {
          key: `${key}/text`,
          nodeId: nid(),
          name: `${name}-label`,
          type: 'text',
          rect: { ...labelRect },
          style: textStyle,
          text: node.text,
          runs: mapRuns(node, textStyle),
          textAutoResize: textAutoResizeFor({ ...node, rect: labelRect }),
          anchorRight: anchorRightFor({ ...node, rect: labelRect }, node, textAutoResizeFor({ ...node, rect: labelRect })),
        },
      ];
      return base;
    }

    if (!kids.length) {
      base.type = 'frame';
      base.style = styleOf(node, false);
      return base;
    }

    base.type = 'frame';
    base.style = styleOf(node, false);
    if (node.overflow && node.overflow !== 'visible') {
      base.clipsContent = true;
    }
    if (node.text) {
      const labelStyle = styleOf(node, true);
      const labelRect = node.textRect ?? node.rect; // measured text span (see button-like branch above)
      base.children = [
        {
          key: `${key}/text`,
          nodeId: nid(),
          name: `${name}-label`,
          type: 'text',
          rect: { ...labelRect },
          style: labelStyle,
          text: node.text,
          runs: mapRuns(node, labelStyle),
          textAutoResize: textAutoResizeFor({ ...node, rect: labelRect }),
          anchorRight: anchorRightFor({ ...node, rect: labelRect }, node, textAutoResizeFor({ ...node, rect: labelRect })),
        },
        ...kids,
      ];
    } else {
      base.children = kids;
    }
    base.childrenCount = base.children.length;
    return base;
  };

  const sections: ReplicaSection[] = [];
  for (const sec of raw.sections) {
    let rootEl = elementFor(sec.root, '');
    if (!rootEl) continue;
    if (opts.collapseContainers !== false) rootEl = collapseReplicaContainers(rootEl);
    // Section rect/style mirror the root element (copies — shifting / canvas-bg
    // stripping below must not double-apply through shared references).
    const section: ReplicaSection = {
      id: rootEl.nodeId,
      name: rootEl.name,
      nodeType: 'ELEMENT',
      rect: { ...rootEl.rect },
      style: { ...rootEl.style },
      elements: [rootEl],
    };
    sections.push(section);
  }

  // Canvas = bounding box of all section roots (content extent, not viewport).
  let cx0 = 0;
  let cy0 = 0;
  let cx1 = 0;
  let cy1 = 0;
  if (sections.length) {
    cx0 = Math.min(...sections.map((s) => s.rect.x));
    cy0 = Math.min(...sections.map((s) => s.rect.y));
    cx1 = Math.max(...sections.map((s) => s.rect.x + s.rect.width));
    cy1 = Math.max(...sections.map((s) => s.rect.y + s.rect.height));
  }
  // Normalize all rects so the canvas origin is (0,0).
  const shiftEl = (el: ReplicaElement) => {
    el.rect.x -= cx0;
    el.rect.y -= cy0;
    el.children?.forEach(shiftEl);
  };
  for (const s of sections) {
    s.rect.x -= cx0;
    s.rect.y -= cy0;
    s.elements.forEach(shiftEl);
  }

  // Page background → Figma main-frame fill. CSS canvas propagation: body's
  // background wins; if body is transparent, html's background paints the
  // canvas. Covers solid colors and gradients. When the section root IS
  // body/html the background is stripped from the section (moved, not copied).
  const resolveBg = (bg?: { color?: string; image?: string }) => ({
    color: parseCssColor(bg?.color)?.hex,
    gradient: gradientFromBackgroundImage(bg?.image),
  });
  const bodyBg = resolveBg(raw.pageBackground?.body);
  const htmlBg = resolveBg(raw.pageBackground?.html);
  let pageBg = bodyBg.color !== undefined || bodyBg.gradient !== undefined ? bodyBg : htmlBg;
  if (pageBg.color === undefined && pageBg.gradient === undefined) {
    // Fallback for raw trees without pageBackground (hand-built / legacy):
    // use the single body/html section root's own background.
    const firstRoot = raw.sections[0]?.root;
    if (raw.sections.length === 1 && firstRoot && (firstRoot.tag === 'body' || firstRoot.tag === 'html')) {
      pageBg = resolveBg({ color: firstRoot.style.backgroundColor, image: firstRoot.style.backgroundImage });
    }
  }
  let canvasBg: string | undefined = pageBg.color;
  const canvasBgImage: string | undefined = pageBg.gradient;

  const first = raw.sections[0]?.root;
  if (sections.length === 1 && first && (first.tag === 'body' || first.tag === 'html')) {
    const rootBg = resolveBg({ color: first.style.backgroundColor, image: first.style.backgroundImage });
    if (rootBg.color !== undefined || rootBg.gradient !== undefined) {
      delete sections[0].style.backgroundColor;
      delete sections[0].style.backgroundAlpha;
      delete sections[0].style.backgroundImage;
      const rootEl = sections[0].elements[0];
      if (rootEl) {
        delete rootEl.style.backgroundColor;
        delete rootEl.style.backgroundAlpha;
        delete rootEl.style.backgroundImage;
      }
    }
  }

  return {
    version: 1,
    source: 'html',
    node: { id: 'html-root', name: opts.name ?? 'html-replica', type: 'PAGE' },
    canvas: {
      width: Math.max(1, Math.round(cx1 - cx0)),
      height: Math.max(1, Math.round(cy1 - cy0)),
      background: canvasBg,
      backgroundImage: canvasBgImage,
    },
    sections,
    assets,
    metadata: {
      generatedAt: new Date().toISOString(),
      options: {
        extractor: 'extractHtmlSpec',
        viewport: raw.viewport,
        pageHeight: raw.pageHeight,
        webfonts: raw.fonts,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const EXTRACT_CACHE_TTL_MS = 5 * 60_000;
const extractCache = new Map<string, { at: number; result: ExtractHtmlSpecResult }>();

/** Test/housekeeping hook: drop all cached extraction results. */
export function clearExtractHtmlCache() {
  extractCache.clear();
}

/**
 * Cache key: same (url, or htmlPath + file mtime, viewport, selectors). Raw
 * `html` string sources are not cached (identity is the caller's string).
 */
function extractCacheKey(opts: ExtractHtmlSpecOptions): string | undefined {
  let src: string | undefined;
  if (opts.url) src = `url:${opts.url}`;
  else if (opts.htmlPath) {
    try {
      const st = fs.statSync(path.resolve(opts.htmlPath));
      src = `file:${path.resolve(opts.htmlPath)}:${st.mtimeMs}`;
    } catch {
      return undefined; // unreadable file: let openPage produce the real error
    }
  } else return undefined;
  const vp = opts.viewport ?? { width: 1440, height: 900 };
  return [
    src,
    `${vp.width}x${vp.height}`,
    opts.rootSelector ?? 'body',
    opts.sectionSelector ?? '',
    opts.includeHidden ? 'H' : '',
    opts.rasterizeSvg === false ? 'noSvg' : '',
    opts.rasterizeRaster === false ? 'noRas' : '',
    String(opts.rasterScale ?? 2),
    opts.hideFixed ? 'hf' : '',
  ].join('|');
}

/**
 * Render the HTML and produce a ReplicaSpec ready for `import_html_replica`.
 * Accepts exactly one of htmlPath / htmlUrl(=url) / html (see RenderOptions).
 * Results for url / htmlPath sources are cached in-process for 5 minutes
 * (disable with cache:false).
 */
export async function extractHtmlToReplicaSpec(opts: ExtractHtmlSpecOptions): Promise<ExtractHtmlSpecResult> {
  const key = opts.cache === false ? undefined : extractCacheKey(opts);
  if (key) {
    const hit = extractCache.get(key);
    if (hit && Date.now() - hit.at < EXTRACT_CACHE_TTL_MS) return hit.result;
  }
  const { raw, title } = await extractRawDom(opts);
  const warnings = [...raw.warnings];
  const name =
    opts.name ??
    (title.trim() ||
      (opts.htmlPath ? path.basename(opts.htmlPath, path.extname(opts.htmlPath)) : undefined) ||
      'html-replica');
  const spec = rawDomToReplicaSpec(raw, { name, warnings });
  const result = { spec, warnings };
  if (key) extractCache.set(key, { at: Date.now(), result });
  return result;
}
