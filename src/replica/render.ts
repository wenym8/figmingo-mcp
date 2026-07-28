/**
 * Playwright rendering + HTML layout extraction.
 * Ported from the internal extract-layout.mjs; brand-specific section lists,
 * class regexes, and asset hints are parameters now.
 *
 * Playwright is imported lazily so unit tests and read-only usage never
 * require a browser install.
 */

import path from 'node:path';

export interface Viewport {
  width: number;
  height: number;
}

export interface SectionDef {
  id: string;
  selector: string;
}

export interface RenderOptions {
  /** Remote URL, or file path to a local .html file, or raw HTML string with `html`. */
  url?: string;
  htmlPath?: string;
  html?: string;
  viewport?: Viewport;
  /** Hide position:fixed/sticky elements before measuring/shooting. */
  hideFixed?: boolean;
  /** Wait for all <img> elements to finish loading (default true). */
  waitForImages?: boolean;
  /** Extra settle time in ms after load (default 300). */
  settleMs?: number;
  /**
   * JS run in the page before any page scripts execute (Playwright
   * addInitScript / evaluateOnNewDocument semantics) — e.g. seed localStorage
   * or flip UI state so one HTML file can render multiple states.
   */
  initScript?: string;
  timeoutMs?: number;
  /** Element selector for a partial screenshot. */
  selector?: string;
  fullPage?: boolean;
}

export interface ScreenshotResult {
  path: string;
  width?: number;
  height?: number;
}

export interface HtmlElementEntry {
  key: string;
  tag: string;
  className: string;
  role?: string | null;
  ariaLabel?: string | null;
  href?: string | null;
  src?: string | null;
  alt?: string | null;
  type: 'text' | 'image' | 'svg' | 'button' | 'input' | 'frame';
  rect: { x: number; y: number; width: number; height: number };
  style: {
    color?: string;
    backgroundColor?: string;
    backgroundImage?: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string;
    letterSpacing?: string;
    lineHeight?: string;
    textAlign?: string;
    textTransform?: string;
    padding?: string;
    borderRadius?: string;
    boxShadow?: string;
    opacity?: string;
  };
  text?: string;
  assetHint?: string;
  svg?: string;
}

export interface HtmlSection {
  id: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  style: Record<string, unknown>;
  elements: HtmlElementEntry[];
}

export interface HtmlLayoutSpec {
  viewport: Viewport;
  pageHeight: number;
  mainFrame: { width: number; height: number; y: number };
  sections: HtmlSection[];
}

export interface ExtractOptions extends RenderOptions {
  sections?: SectionDef[];
  /** Class-name regex (string) for div elements that count as text. */
  textualDivClassPattern?: string;
  /** Class names that mark an <a> as a button. Default ['btn','button']. */
  buttonClasses?: string[];
  /** Extra <img> asset-hint rules: [{ pattern (class regex), hint }] — first match wins. */
  assetHintRules?: Array<{ pattern: string; hint: string }>;
  /** Capture outerHTML for svg elements (default false). */
  captureSvg?: boolean;
}

async function launchBrowser() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    // Fall back to the system Chrome channel when the bundled browser is not installed.
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' });
    } catch {
      throw new Error(
        'Playwright chromium is not available. Run `npx playwright install chromium` ' +
          `(or install Google Chrome). Original error: ${(err as Error).message}`,
      );
    }
  }
}

async function openPage(browser: Awaited<ReturnType<typeof launchBrowser>>, opts: RenderOptions) {
  const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1440, height: 900 } });
  const timeout = opts.timeoutMs ?? 60000;
  if (opts.initScript) await page.addInitScript(opts.initScript);
  if (opts.html !== undefined) {
    await page.setContent(opts.html, { waitUntil: 'load', timeout });
  } else if (opts.htmlPath) {
    const resolved = path.resolve(opts.htmlPath);
    await page.goto(`file://${resolved}`, { waitUntil: 'load', timeout });
  } else if (opts.url) {
    await page.goto(opts.url, { waitUntil: 'networkidle', timeout });
  } else {
    throw new Error('render: one of url / htmlPath / html is required');
  }
  if (opts.waitForImages !== false) {
    await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const pending = imgs.filter((img) => !img.complete);
      const all = pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          }),
      );
      return Promise.all([Promise.all(all), (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready]);
    });
  }
  if (opts.hideFixed) {
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('*').forEach((el) => {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          el.style.visibility = 'hidden';
          el.setAttribute('data-figmingo-hidden', '1');
        }
      });
    });
  }
  await page.waitForTimeout(opts.settleMs ?? 300);
  return page;
}

/** Screenshot of a page or element selector. Returns the output path. */
export async function renderScreenshot(opts: RenderOptions & { outPath: string }): Promise<ScreenshotResult> {
  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, opts);
    const outPath = path.resolve(opts.outPath);
    if (opts.selector) {
      const loc = page.locator(opts.selector).first();
      await loc.screenshot({ path: outPath, timeout: opts.timeoutMs ?? 30000 });
      const box = await loc.boundingBox().catch(() => null);
      return { path: outPath, width: box?.width ? Math.round(box.width) : undefined, height: box?.height ? Math.round(box.height) : undefined };
    }
    await page.screenshot({ path: outPath, fullPage: opts.fullPage !== false });
    return { path: outPath };
  } finally {
    await browser.close();
  }
}

/** Extract a layout spec from rendered HTML (the HTML side of the parity comparison). */
export async function extractHtmlSpec(opts: ExtractOptions): Promise<HtmlLayoutSpec> {
  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, opts);
    const sectionDefs: SectionDef[] | undefined = opts.sections;
    const params = {
      sectionDefs,
      textualDivRe: opts.textualDivClassPattern ?? null,
      buttonClasses: opts.buttonClasses ?? ['btn', 'button'],
      assetHintRules: opts.assetHintRules ?? [],
      captureSvg: opts.captureSvg === true,
    };
    const spec = await page.evaluate((p) => {
      const scrollY = window.scrollY;
      const docTop = document.documentElement.getBoundingClientRect().top + scrollY;
      const textualDivRe = p.textualDivRe ? new RegExp(p.textualDivRe) : null;
      const hintRules = p.assetHintRules.map((r) => ({ re: new RegExp(r.pattern), hint: r.hint }));

      function rect(el: Element) {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left),
          y: Math.round(r.top + scrollY - docTop),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }

      function style(el: Element) {
        const cs = getComputedStyle(el);
        return {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          backgroundImage: cs.backgroundImage,
          fontFamily: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
          fontSize: parseFloat(cs.fontSize),
          fontWeight: cs.fontWeight,
          letterSpacing: cs.letterSpacing,
          lineHeight: cs.lineHeight,
          textAlign: cs.textAlign,
          textTransform: cs.textTransform,
          padding: cs.padding,
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
          opacity: cs.opacity,
        };
      }

      function textOf(el: Element): string {
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') return (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || '';
        if (tag === 'summary') return (el.textContent || '').trim();
        return ((el as HTMLElement).innerText || '').trim();
      }

      function isTextElement(el: Element, tag: string): boolean {
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'summary', 'a', 'li', 'label', 'strong', 'em', 'small'].includes(tag)) {
          return true;
        }
        if (tag !== 'div') return false;
        const cls = (el as HTMLElement).className?.toString?.() || '';
        if (textualDivRe && textualDivRe.test(cls)) return true;
        if (el.childElementCount === 0) return true;
        return false;
      }

      function walk(el: Element, parentKey: string, out: unknown[]) {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template'].includes(tag)) return;
        if ((el as HTMLElement).hasAttribute?.('data-figmingo-hidden')) return;
        const r = rect(el);
        if (r.width < 1 || r.height < 1) return;
        const htmlEl = el as HTMLElement;
        const key = el.id
          ? `${parentKey}/${el.id}`
          : `${parentKey}/${tag}${htmlEl.className ? '.' + String(htmlEl.className).split(/\s+/).slice(0, 2).join('.') : ''}`;
        const entry: Record<string, unknown> = {
          key,
          tag,
          className: htmlEl.className?.toString?.() || '',
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          href: el.getAttribute('href'),
          src: el.getAttribute('src'),
          alt: el.getAttribute('alt'),
          rect: r,
          style: style(el),
          text: ['img', 'svg'].includes(tag) ? '' : textOf(el),
        };
        if (tag === 'img') {
          entry.type = 'image';
          const alt = (el.getAttribute('alt') || '').toLowerCase();
          if (alt.includes('logo')) entry.assetHint = 'logo';
          else {
            for (const rule of hintRules) {
              let node: Element | null = el;
              while (node) {
                if (rule.re.test(String((node as HTMLElement).className ?? ''))) {
                  entry.assetHint = rule.hint;
                  break;
                }
                node = node.parentElement;
              }
              if (entry.assetHint) break;
            }
          }
        } else if (tag === 'svg') {
          entry.type = 'svg';
          if (p.captureSvg) entry.svg = el.outerHTML;
        } else if (tag === 'a' && p.buttonClasses.some((c) => htmlEl.classList.contains(c))) {
          entry.type = 'button';
        } else if (tag === 'button') {
          entry.type = 'button';
        } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          entry.type = 'input';
        } else if (entry.text && isTextElement(el, tag)) {
          entry.type = 'text';
        } else {
          entry.type = 'frame';
        }
        out.push(entry);
        for (const child of Array.from(el.children)) {
          if (child.tagName === 'SVG' && tag === 'a') continue;
          walk(child, key, out);
        }
      }

      const sections: unknown[] = [];
      let mainHeight = 0;
      const AUTO_SEL = 'header, main > section, main > article, main > div, body > section, footer';
      let defs: Array<{ id: string; selector: string }> = p.sectionDefs ?? [];
      if (!defs.length) {
        // Auto mode: derive one section per semantic top-level element.
        const semantic = Array.from(document.querySelectorAll(AUTO_SEL));
        defs = semantic.map((el, i) => {
          const tag = el.tagName.toLowerCase();
          const cls = String((el as HTMLElement).className || '').split(/\s+/)[0];
          return { id: el.id || (cls ? `${tag}-${cls}` : `${tag}-${i}`), selector: `__auto__${i}` };
        });
        if (!defs.length && document.body) defs = [{ id: 'body', selector: 'body' }];
      }
      const autoRoots = Array.from(document.querySelectorAll(AUTO_SEL));
      const resolveRoot = (def: { id: string; selector: string }): Element | null => {
        if (def.selector.startsWith('__auto__')) return autoRoots[Number(def.selector.slice(8))] ?? null;
        return def.selector ? document.querySelector(def.selector) : null;
      };
      for (const def of defs) {
        const root = resolveRoot(def);
        if (!root) continue;
        const r = rect(root);
        const elements: unknown[] = [];
        walk(root, def.id, elements);
        sections.push({ id: def.id, selector: def.selector, rect: r, style: style(root), elements });
        mainHeight = Math.max(mainHeight, r.y + r.height);
      }
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        pageHeight: Math.round(document.documentElement.scrollHeight),
        mainFrame: { width: window.innerWidth, height: Math.ceil(mainHeight), y: 0 },
        sections,
      };
    }, params);
    return spec as HtmlLayoutSpec;
  } finally {
    await browser.close();
  }
}
