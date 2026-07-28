import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HTML_FIXTURE = new URL('../fixtures/page.html', import.meta.url).pathname;

let browserAvailable = false;
let browserError = '';

beforeAll(async () => {
  try {
    const { chromium } = await import('playwright');
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      browser = await chromium.launch({ headless: true, channel: 'chrome' });
    }
    await browser.close();
    browserAvailable = true;
  } catch (err) {
    browserError = (err as Error).message;
  }
}, 60000);

function skipUnlessChrome() {
  if (!browserAvailable) {
    console.warn(`SKIP: chromium unavailable (${browserError.split('\n')[0]}). Run \`npx playwright install chromium\` to enable render tests.`);
    return true;
  }
  return false;
}

describe('render (playwright)', () => {
  it('renderScreenshot captures full page and selectors, waits for images', async (ctx) => {
    if (skipUnlessChrome()) return ctx.skip();
    const { renderScreenshot } = await import('../../src/replica/render');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-render-'));
    const full = path.join(dir, 'full.png');
    const r = await renderScreenshot({ htmlPath: HTML_FIXTURE, outPath: full, viewport: { width: 1440, height: 900 } });
    expect(fs.existsSync(r.path)).toBe(true);
    expect(fs.statSync(r.path).size).toBeGreaterThan(1000);

    const part = path.join(dir, 'hero.png');
    const r2 = await renderScreenshot({ htmlPath: HTML_FIXTURE, selector: 'section.hero', outPath: part });
    expect(fs.existsSync(r2.path)).toBe(true);
    expect(r2.width).toBe(1440);
    expect(r2.height).toBe(500);
  });

  it('extractHtmlSpec walks sections and computes styles', async (ctx) => {
    if (skipUnlessChrome()) return ctx.skip();
    const { extractHtmlSpec } = await import('../../src/replica/render');
    const spec = await extractHtmlSpec({
      htmlPath: HTML_FIXTURE,
      viewport: { width: 1440, height: 900 },
      sections: [
        { id: 'header', selector: 'header.topbar' },
        { id: 'hero', selector: 'section.hero' },
        { id: 'footer', selector: 'footer.footer' },
      ],
    });
    expect(spec.sections).toHaveLength(3);
    const header = spec.sections[0];
    expect(header.rect.height).toBe(64);
    const logo = header.elements.find((e) => e.className === 'logo');
    expect(logo?.type).toBe('text');
    expect(logo?.style.fontSize).toBe(20);
    const hero = spec.sections[1];
    const h1 = hero.elements.find((e) => e.tag === 'h1');
    expect(h1?.style.fontSize).toBe(56);
    expect(h1?.rect.x).toBe(120);
    const btn = hero.elements.find((e) => e.className === 'btn');
    expect(btn?.type).toBe('button');
  });

  it('extractHtmlSpec auto-detects semantic sections', async (ctx) => {
    if (skipUnlessChrome()) return ctx.skip();
    const { extractHtmlSpec } = await import('../../src/replica/render');
    const spec = await extractHtmlSpec({ htmlPath: HTML_FIXTURE });
    const ids = spec.sections.map((s) => s.id);
    expect(ids.some((id) => id.startsWith('header'))).toBe(true);
    expect(ids.some((id) => id.startsWith('footer'))).toBe(true);
  });

  it('hideFixed hides fixed elements', async (ctx) => {
    if (skipUnlessChrome()) return ctx.skip();
    const { renderScreenshot, extractHtmlSpec } = await import('../../src/replica/render');
    const html = `<html><body style="margin:0">
      <div style="height:200px;background:#eee">content</div>
      <div id="floater" style="position:fixed;bottom:20px;right:20px;width:60px;height:60px;background:red">x</div>
      </body></html>`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-fixed-'));
    await renderScreenshot({ html, outPath: path.join(dir, 'a.png'), hideFixed: true });
    const spec = await extractHtmlSpec({ html, hideFixed: true });
    const floater = spec.sections.flatMap((s) => s.elements).find((e) => e.key.includes('floater'));
    expect(floater).toBeUndefined(); // hidden elements have zero-size rects and are skipped
  });
});
