import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { comparePngBuffers } from '../../src/replica/verify';
import { compareHtmlToImage } from '../../src/tools/replica/compareHtmlToImage';
import { makeCtx } from './helpers';

const HTML_FIXTURE = new URL('../fixtures/page.html', import.meta.url).pathname;

function makePng(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = paint(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

describe('comparePngBuffers', () => {
  it('passes identical images with zero ratio', () => {
    const a = makePng(50, 40, () => [10, 20, 30, 255]);
    const r = comparePngBuffers(a, a);
    expect(r.passed).toBe(true);
    expect(r.diffRatio).toBe(0);
    expect(r.diffPixels).toBe(0);
    expect(r.antiAliasPixels).toBe(0);
    expect(r.size).toEqual({ render: [50, 40], reference: [50, 40] });
  });

  it('reports an exact diff ratio for known pixel counts', () => {
    const base = makePng(100, 100, () => [255, 255, 255, 255]);
    // 20x20 block of solid black in the middle = 400 diff pixels.
    const changed = makePng(100, 100, (x, y) => (x >= 40 && x < 60 && y >= 40 && y < 60 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const r = comparePngBuffers(base, changed);
    expect(r.diffPixels).toBe(400);
    expect(r.diffRatio).toBeCloseTo(0.04, 6);
    expect(r.passed).toBe(false);
    // Raising the pass line above the ratio flips the verdict.
    expect(comparePngBuffers(base, changed, { maxRatio: 0.05 }).passed).toBe(true);
  });

  it('localizes diffs into bands whose counts sum to the total', () => {
    const base = makePng(100, 100, () => [255, 255, 255, 255]);
    // Diff pixels only in y∈[40,60) → with 10 bands of 10px, bands 4 and 5.
    const changed = makePng(100, 100, (x, y) => (y >= 40 && y < 60 && x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const r = comparePngBuffers(base, changed, { bands: 10 });
    expect(r.bands).toHaveLength(10);
    const sum = r.bands!.reduce((acc, b) => acc + b.diffPixels, 0);
    expect(sum).toBe(r.diffPixels);
    expect(r.diffPixels).toBe(200);
    for (const band of r.bands!) {
      if (band.index === 4 || band.index === 5) expect(band.diffPixels).toBe(100);
      else expect(band.diffPixels).toBe(0);
      expect(band.yEnd).toBeGreaterThan(band.yStart);
    }
  });

  it('errors on size mismatch beyond the 2px crop tolerance', () => {
    const a = makePng(100, 100, () => [1, 2, 3, 255]);
    const b = makePng(110, 100, () => [1, 2, 3, 255]);
    const r = comparePngBuffers(a, b);
    expect(r.passed).toBe(false);
    expect(r.error).toContain('size_mismatch');
  });

  it('writes a diff PNG to outPath', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-cmp-unit-'));
    const out = path.join(dir, 'diff.png');
    const a = makePng(20, 20, () => [255, 255, 255, 255]);
    const b = makePng(20, 20, (x) => (x < 5 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const r = comparePngBuffers(a, b, { outPath: out });
    expect(r.diffImagePath).toBe(out);
    expect(fs.existsSync(out)).toBe(true);
  });
});

// ---- tool-level: real chromium render compared against itself ----

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
    console.warn(`SKIP: chromium unavailable (${browserError.split('\n')[0]}). Run \`npx playwright install chromium\` to enable compare tests.`);
    return true;
  }
  return false;
}

describe('compare_html_to_image tool', () => {
  it('renders the fixture and matches a screenshot of itself', async (ctx) => {
    if (skipUnlessChrome()) return ctx.skip();
    const { renderScreenshot } = await import('../../src/replica/render');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-cmp-tool-'));
    const ref = path.join(dir, 'ref.png');
    await renderScreenshot({ htmlPath: HTML_FIXTURE, outPath: ref, viewport: { width: 1440, height: 900 } });

    const res = await compareHtmlToImage.handler(makeCtx(), {
      htmlPath: HTML_FIXTURE,
      imagePath: ref,
      viewportWidth: 1440,
      viewportHeight: 900,
      bands: 10,
    });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.passed).toBe(true);
    expect(parsed.diffRatio).toBeLessThanOrEqual(0.01);
    expect(parsed.bands).toHaveLength(10);
    expect(parsed.diffImagePath).toBeTruthy();
  });

  it('fails when the reference image is altered, and bands point at the change', async (ctx) => {
    if (skipUnlessChrome()) return ctx.skip();
    const { renderScreenshot } = await import('../../src/replica/render');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-cmp-tool2-'));
    const ref = path.join(dir, 'ref.png');
    await renderScreenshot({ htmlPath: HTML_FIXTURE, outPath: ref, viewport: { width: 1440, height: 900 } });

    // Paint a solid black bar across the middle of the reference.
    const png = PNG.sync.read(fs.readFileSync(ref));
    const y0 = Math.floor(png.height / 2) - 25;
    for (let y = y0; y < y0 + 50; y++) {
      for (let x = 100; x < Math.min(500, png.width); x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
        png.data[i + 3] = 255;
      }
    }
    const altered = path.join(dir, 'altered.png');
    fs.writeFileSync(altered, PNG.sync.write(png));

    const res = await compareHtmlToImage.handler(makeCtx(), {
      htmlPath: HTML_FIXTURE,
      imagePath: altered,
      viewportWidth: 1440,
      viewportHeight: 900,
      bands: 10,
    });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.passed).toBe(false);
    expect(parsed.diffPixels).toBeGreaterThan(0);
    // The altered bar sits in the middle → middle band(s) dominate.
    const top = [...parsed.bands].sort((a: { diffPixels: number }, b: { diffPixels: number }) => b.diffPixels - a.diffPixels)[0];
    expect(top.index).toBeGreaterThanOrEqual(4);
    expect(top.index).toBeLessThanOrEqual(5);
  });

  it('returns a clean error when the reference image does not exist', async () => {
    const res = await compareHtmlToImage.handler(makeCtx(), {
      htmlPath: HTML_FIXTURE,
      imagePath: '/nonexistent/definitely-not-here.png',
    });
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.passed).toBe(false);
    expect(parsed.error).toContain('reference_not_found');
  });
});
