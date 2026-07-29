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
 *  - `<svg>`                    → type 'svg', asset as a data:image/svg+xml URL.
 *                                 (Figma's createImage cannot rasterize SVG —
 *                                 the importer emits a warning + placeholder.)
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
 * (nested matches collapse to the outermost). When the root is <body>, its
 * background moves to spec.canvas.background (Figma-canvas-like), matching
 * the hand-written spec convention.
 *
 * Webfont families seen by document.fonts are recorded in
 * spec.metadata.options.webfonts for downstream font mapping.
 */

import path from 'node:path';
import { launchBrowser, openPage, type RenderOptions, type Viewport } from './render';
import { parseCssColor } from './css';
import type { ReplicaAsset, ReplicaElement, ReplicaSection, ReplicaSpec, SpecStyle } from './spec';

export interface ExtractHtmlSpecOptions extends RenderOptions {
  /** CSS selector for the replica root (default 'body'). */
  rootSelector?: string;
  /** CSS selector splitting the page into multiple sections (default: single section). */
  sectionSelector?: string;
  /** Frame/spec name (default: document title or the HTML file basename). */
  name?: string;
}

export interface ExtractHtmlSpecResult {
  spec: ReplicaSpec;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Raw DOM tree (produced inside the page, JSON-serializable)
// ---------------------------------------------------------------------------

export interface RawDomNode {
  tag: string;
  id?: string;
  className?: string;
  /** Direct text-node content (element children excluded), whitespace-collapsed. */
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  src?: string;
  svg?: string;
  imgBroken?: boolean;
  overflow?: string;
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
    const params = { rootSelector: opts.rootSelector ?? 'body', sectionSelector: opts.sectionSelector ?? null };
    const raw = await page.evaluate((p) => {
      const warnings: string[] = [];
      const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'br']);

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

      function walk(el: Element): unknown | null {
        const tag = el.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return null;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return null;
        if (parseFloat(cs.opacity) === 0) return null;
        if ((el as HTMLElement).hasAttribute?.('data-figmingo-hidden')) return null;
        const rect = rectOf(el);
        const children: unknown[] = [];
        for (const child of Array.from(el.children)) {
          const c = walk(child);
          if (c) children.push(c);
        }
        const text = ownText(el);
        if (rect.width < 1 || rect.height < 1) {
          // Zero-size elements only survive if they carry visible descendants.
          if (!children.length) return null;
        }
        const node: Record<string, unknown> = {
          tag,
          id: el.id || undefined,
          // getAttribute('class') works for SVG too (className is an
          // SVGAnimatedString there, not a plain string).
          className: el.getAttribute('class') || undefined,
          rect,
          text: text || undefined,
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
          node.src = img.currentSrc || img.src || undefined;
          if (!img.complete || img.naturalWidth === 0) {
            node.imgBroken = true;
            warnings.push(`img failed to load: ${node.src ?? '(no src)'}`);
          }
        }
        if (tag === 'svg') node.svg = el.outerHTML;
        return node;
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
          const r = walk(root);
          return r ? { root: r } : null;
        })
        .filter(Boolean);

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

      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        pageHeight: Math.round(document.documentElement.scrollHeight),
        fonts: Array.from(new Set(fonts)),
        warnings,
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

  const elementFor = (node: RawDomNode, parentKey: string): ReplicaElement | null => {
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
      if (node.src) {
        const asset = addAsset('image', node.src, fileNameFor(node.src, `${name}.png`));
        base.assetId = asset.id;
      }
      if (/logo/i.test(name)) base.assetHint = 'logo';
      else if (/icon|ic[_-]/i.test(name)) base.assetHint = 'icon';
      return base;
    }

    if (node.tag === 'svg') {
      base.type = 'svg';
      base.assetHint = 'icon';
      if (node.svg) {
        const url = `data:image/svg+xml;utf8,${encodeURIComponent(node.svg)}`;
        const asset = addAsset('svg', url, `${name}.svg`);
        base.assetId = asset.id;
      }
      return base;
    }

    const kids = node.children.map((c) => elementFor(c, key)).filter((c): c is ReplicaElement => c !== null);
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
        return base;
      }
      // Button/input-like: visible box + label → frame with synthetic text child.
      base.type = 'frame';
      base.style = styleOf(node, false);
      const textStyle = styleOf(node, true);
      base.children = [
        {
          key: `${key}/text`,
          nodeId: nid(),
          name: `${name}-label`,
          type: 'text',
          rect: { ...node.rect },
          style: textStyle,
          text: node.text,
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
      base.children = [
        {
          key: `${key}/text`,
          nodeId: nid(),
          name: `${name}-label`,
          type: 'text',
          rect: { ...node.rect },
          style: styleOf(node, true),
          text: node.text,
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
    const rootEl = elementFor(sec.root, '');
    if (!rootEl) continue;
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

  // <body> background becomes the Figma canvas background (page-level paint).
  let canvasBg: string | undefined;
  const first = raw.sections[0]?.root;
  if (sections.length === 1 && first && (first.tag === 'body' || first.tag === 'html')) {
    const bg = parseCssColor(first.style.backgroundColor);
    if (bg?.hex) {
      canvasBg = bg.hex;
      delete sections[0].style.backgroundColor;
      delete sections[0].style.backgroundAlpha;
      const rootEl = sections[0].elements[0];
      if (rootEl) {
        delete rootEl.style.backgroundColor;
        delete rootEl.style.backgroundAlpha;
      }
    }
  }

  return {
    version: 1,
    source: 'html',
    node: { id: 'html-root', name: opts.name ?? 'html-replica', type: 'PAGE' },
    canvas: { width: Math.max(1, Math.round(cx1 - cx0)), height: Math.max(1, Math.round(cy1 - cy0)), background: canvasBg },
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

/**
 * Render the HTML and produce a ReplicaSpec ready for `import_html_replica`.
 * Accepts exactly one of htmlPath / htmlUrl(=url) / html (see RenderOptions).
 */
export async function extractHtmlToReplicaSpec(opts: ExtractHtmlSpecOptions): Promise<ExtractHtmlSpecResult> {
  const { raw, title } = await extractRawDom(opts);
  const warnings = [...raw.warnings];
  const name =
    opts.name ??
    (title.trim() ||
      (opts.htmlPath ? path.basename(opts.htmlPath, path.extname(opts.htmlPath)) : undefined) ||
      'html-replica');
  const spec = rawDomToReplicaSpec(raw, { name, warnings });
  return { spec, warnings };
}
