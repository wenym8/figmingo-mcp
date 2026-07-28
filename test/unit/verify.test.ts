import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import {
  POS_TOL,
  COLOR_TOL,
  FONT_SIZE_TOL,
  LS_TOL,
  LH_TOL,
  VISUAL_MAX_RATIO,
  normalizeText,
  runContentGate,
  runStructuralGate,
  runVisualGate,
  diffImages,
  matchSection,
  getPlaceables,
} from '../../src/replica/verify';
import type { ReplicaSpec } from '../../src/replica/spec';
import type { HtmlLayoutSpec, HtmlElementEntry } from '../../src/replica/render';

// ---- A minimal spec ↔ html pair that should match perfectly ----

const spec: ReplicaSpec = {
  version: 1,
  source: 'figma-rest',
  file: { key: 'k', name: 'F' },
  node: { id: '1:2', name: 'Page', type: 'FRAME' },
  canvas: { width: 1440, height: 400, background: '#ffffff' },
  sections: [
    {
      id: '1:3',
      name: 'Header',
      nodeType: 'FRAME',
      rect: { x: 0, y: 0, width: 1440, height: 64 },
      style: { backgroundColor: '#f5f7fa', backgroundAlpha: 1, backgroundImage: 'none' },
      elements: [
        {
          key: '1:3', nodeId: '1:3', name: 'Header', type: 'frame',
          rect: { x: 0, y: 0, width: 1440, height: 64 },
          style: { backgroundColor: '#f5f7fa', backgroundAlpha: 1, backgroundImage: 'none' },
        },
        {
          key: '1:3/1:4', nodeId: '1:4', name: 'Logo', type: 'text',
          rect: { x: 32, y: 20, width: 120, height: 24 },
          style: {
            color: '#111111', colorAlpha: 1, fontFamily: 'Inter', fontStyleName: 'Bold', fontWeight: 700,
            fontSize: 20, letterSpacing: 0.5, lineHeight: 24, textAlign: 'left', textTransform: 'uppercase',
          },
          text: 'ACME',
        },
      ],
    },
    {
      id: '1:10',
      name: 'Hero',
      nodeType: 'FRAME',
      rect: { x: 0, y: 64, width: 1440, height: 336 },
      style: { backgroundImage: 'linear-gradient(90deg, #f0f7fc 0%, #ffffff 100%)' },
      elements: [
        {
          key: '1:10', nodeId: '1:10', name: 'Hero', type: 'frame',
          rect: { x: 0, y: 64, width: 1440, height: 336 },
          style: { backgroundImage: 'linear-gradient(90deg, #f0f7fc 0%, #ffffff 100%)' },
        },
        {
          key: '1:10/1:11', nodeId: '1:11', name: 'Headline', type: 'text',
          rect: { x: 120, y: 144, width: 700, height: 64 },
          style: {
            color: '#111111', colorAlpha: 1, fontFamily: 'Inter', fontStyleName: 'Bold', fontWeight: 700,
            fontSize: 56, letterSpacing: -1, lineHeight: 64, textAlign: 'left', textTransform: 'none',
          },
          text: 'Build faster with ACME',
        },
        {
          key: '1:10/1:20', nodeId: '1:20', name: 'Logo Image', type: 'image', assetHint: 'logo', assetId: 'img-a',
          rect: { x: 900, y: 144, width: 400, height: 300 },
          style: {},
        },
        {
          key: '1:10/1:21', nodeId: '1:21', name: 'icon/check', type: 'svg', assetHint: 'icon', assetId: 'svg-1-21',
          rect: { x: 120, y: 360, width: 24, height: 24 },
          style: {},
        },
        {
          key: '1:10/1:13', nodeId: '1:13', name: 'CTA', type: 'frame',
          rect: { x: 120, y: 240, width: 180, height: 48 },
          style: { backgroundColor: '#005a88', backgroundAlpha: 1, backgroundImage: 'none' },
        },
      ],
    },
  ],
  assets: [],
  metadata: { generatedAt: '2026-07-29T00:00:00Z' },
};

function htmlEl(partial: Partial<HtmlElementEntry> & Pick<HtmlElementEntry, 'key' | 'type' | 'rect'>): HtmlElementEntry {
  return { tag: 'div', className: '', style: {}, ...partial };
}

const html: HtmlLayoutSpec = {
  viewport: { width: 1440, height: 900 },
  pageHeight: 400,
  mainFrame: { width: 1440, height: 400, y: 0 },
  sections: [
    {
      id: 'header', selector: 'header',
      rect: { x: 0, y: 0, width: 1440, height: 64 }, style: {},
      elements: [
        htmlEl({
          key: 'header/div.logo', tag: 'div', className: 'logo', type: 'text',
          rect: { x: 32, y: 20, width: 120, height: 24 }, text: 'ACME',
          style: {
            color: 'rgb(17, 17, 17)', fontFamily: 'Inter', fontWeight: '700', fontSize: 20,
            letterSpacing: '0.5px', lineHeight: '24px', textTransform: 'uppercase', textAlign: 'left',
          },
        }),
        htmlEl({
          key: 'header', tag: 'header', className: 'topbar', type: 'frame',
          rect: { x: 0, y: 0, width: 1440, height: 64 },
          style: { backgroundColor: 'rgb(245, 247, 250)', backgroundImage: 'none' },
        }),
      ],
    },
    {
      id: 'hero', selector: 'section.hero',
      rect: { x: 0, y: 64, width: 1440, height: 336 }, style: {},
      elements: [
        htmlEl({
          key: 'hero/h1', tag: 'h1', type: 'text',
          rect: { x: 120, y: 144, width: 700, height: 64 }, text: 'Build faster with ACME',
          style: {
            color: 'rgb(17, 17, 17)', fontFamily: 'Inter', fontWeight: '700', fontSize: 56,
            letterSpacing: '-1px', lineHeight: '64px', textTransform: 'none', textAlign: 'left',
          },
        }),
        htmlEl({
          key: 'hero/img.logo', tag: 'img', className: 'logo-img', type: 'image', assetHint: 'logo',
          rect: { x: 900, y: 144, width: 400, height: 300 },
        }),
        htmlEl({
          key: 'hero/svg', tag: 'svg', type: 'svg',
          rect: { x: 120, y: 360, width: 24, height: 24 },
        }),
        htmlEl({
          key: 'hero/a.btn', tag: 'a', className: 'btn', type: 'button',
          rect: { x: 120, y: 240, width: 180, height: 48 },
          style: { backgroundColor: 'rgb(0, 90, 136)', backgroundImage: 'none' },
        }),
      ],
    },
  ],
};

describe('tolerance constants (ported from parity-lib)', () => {
  it('matches the proven values', () => {
    expect(POS_TOL).toBe(4);
    expect(COLOR_TOL).toBeCloseTo(2 / 255, 6);
    expect(FONT_SIZE_TOL).toBe(1);
    expect(LS_TOL).toBe(0.5);
    expect(LH_TOL).toBe(2);
    expect(VISUAL_MAX_RATIO).toBe(0.01);
  });
});

describe('content gate', () => {
  it('passes a well-matched page', () => {
    const gate = runContentGate(spec, html);
    expect(gate.passed).toBe(true);
    expect(gate.copy.missing).toHaveLength(0);
    expect(gate.font.failures).toHaveLength(0);
    expect(gate.color.failures).toHaveLength(0);
    expect(gate.image.logos).toBe(1);
    expect(gate.image.icons).toBe(1);
  });

  it('flags copy mismatches and missing text', () => {
    const bad: HtmlLayoutSpec = JSON.parse(JSON.stringify(html));
    bad.sections[0].elements[0].text = 'WRONG CORP';
    bad.sections[1].elements = bad.sections[1].elements.filter((e) => e.type !== 'text');
    const gate = runContentGate(spec, bad);
    expect(gate.passed).toBe(false);
    expect(gate.copy.mismatch.length + gate.copy.missing.length).toBeGreaterThan(0);
  });

  it('flags font drift beyond tolerances', () => {
    const bad: HtmlLayoutSpec = JSON.parse(JSON.stringify(html));
    bad.sections[1].elements[0].style.fontSize = 58; // +2 > FONT_SIZE_TOL
    bad.sections[0].elements[0].style.letterSpacing = '2px'; // +1.5 > LS_TOL
    const gate = runContentGate(spec, bad);
    expect(gate.font.passed).toBe(false);
    expect(gate.font.failures.length).toBeGreaterThanOrEqual(2);
  });

  it('flags color drift beyond 2/255', () => {
    const bad: HtmlLayoutSpec = JSON.parse(JSON.stringify(html));
    bad.sections[1].elements[0].style.color = 'rgb(17, 17, 40)';
    const gate = runContentGate(spec, bad);
    expect(gate.color.passed).toBe(false);
  });

  it('expectedCounts are parameterized (no hard-coded counts)', () => {
    const gate = runContentGate(spec, html, { expectedCounts: { logos: 2 } });
    expect(gate.passed).toBe(false);
    expect(gate.countFailures.join(' ')).toContain('logos 1 != 2');
    const ok = runContentGate(spec, html, { expectedCounts: { logos: 1, minIcons: 1 } });
    expect(ok.image.passed).toBe(true);
  });

  it('skipSections is parameterized', () => {
    const gate = runContentGate(spec, html, { skipSections: ['Hero'] });
    // Hero elements are skipped; header-only check passes
    expect(gate.copy.missing).toHaveLength(0);
    expect(gate.image.logos).toBe(0);
  });
});

describe('structural gate', () => {
  it('passes within ±4px', () => {
    const near: HtmlLayoutSpec = JSON.parse(JSON.stringify(html));
    near.sections[1].elements[0].rect.x += POS_TOL; // exactly at tolerance
    const gate = runStructuralGate(spec, near);
    expect(gate.passed).toBe(true);
    expect(gate.matched).toBe(gate.total);
  });

  it('flags position drift beyond tolerance', () => {
    const bad: HtmlLayoutSpec = JSON.parse(JSON.stringify(html));
    bad.sections[1].elements[0].rect.y += 10;
    const gate = runStructuralGate(spec, bad);
    expect(gate.passed).toBe(false);
    expect(gate.failures.some((f: any) => f.reason === 'position')).toBe(true);
  });

  it('flags section bounds drift', () => {
    const bad: HtmlLayoutSpec = JSON.parse(JSON.stringify(html));
    bad.sections[1].rect.y += 30;
    const gate = runStructuralGate(spec, bad);
    expect(gate.failures.some((f: any) => f.reason === 'section_bounds')).toBe(true);
  });

  it('reports missing elements', () => {
    const bad: HtmlLayoutSpec = JSON.parse(JSON.stringify(html));
    bad.sections[1].elements = bad.sections[1].elements.filter((e) => e.type !== 'image');
    const gate = runStructuralGate(spec, bad);
    expect(gate.failures.some((f: any) => f.reason === 'missing')).toBe(true);
  });
});

describe('matching', () => {
  it('getPlaceables skips section roots and empty text', () => {
    const placeables = getPlaceables(spec.sections[0]);
    expect(placeables).toHaveLength(1); // only the logo text; root frame excluded
    expect(placeables[0].placeType).toBe('text');
    expect(placeables[0].rel).toEqual({ x: 32, y: 20, width: 120, height: 24 });
  });

  it('matchSection pairs every placeable', () => {
    const pairs = matchSection(spec.sections[1], html.sections[1]);
    const unmatched = pairs.filter((p) => !p.html);
    expect(unmatched).toHaveLength(0);
  });
});

// ---- visual gate ----

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

describe('visual gate (pixelmatch)', () => {
  it('passes identical images', () => {
    const a = makePng(50, 40, () => [10, 20, 30, 255]);
    const b = makePng(50, 40, () => [10, 20, 30, 255]);
    const r = diffImages(a, b);
    expect(r.passed).toBe(true);
    expect(r.diffRatio).toBe(0);
  });

  it('passes small diffs under 1% and fails larger ones', () => {
    const base = makePng(100, 100, () => [255, 255, 255, 255]);
    const fewBad = makePng(100, 100, (x, y) => (x === 0 && y < 50 ? [0, 0, 0, 255] : [255, 255, 255, 255])); // 0.5%
    const manyBad = makePng(100, 100, (x, y) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255])); // 20%
    expect(diffImages(base, fewBad).passed).toBe(true);
    expect(diffImages(base, manyBad).passed).toBe(false);
  });

  it('tolerates size differences within 2px crop tolerance', () => {
    const a = makePng(100, 100, () => [1, 2, 3, 255]);
    const b = makePng(102, 101, () => [1, 2, 3, 255]);
    expect(diffImages(a, b).passed).toBe(true);
    const c = makePng(110, 100, () => [1, 2, 3, 255]);
    expect(diffImages(a, c).passed).toBe(false);
    expect(diffImages(a, c).error).toContain('size_mismatch');
  });

  it('runVisualGate aggregates comparisons and writes diff images', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-diff-'));
    const a = makePng(20, 20, () => [255, 0, 0, 255]);
    const b = makePng(20, 20, () => [0, 0, 255, 255]);
    const gate = runVisualGate([{ name: 'page', expected: a, actual: b }], dir);
    expect(gate.passed).toBe(false);
    expect(gate.comparisons[0].diffPath).toContain('diff-page.png');
    expect(fs.existsSync(gate.comparisons[0].diffPath!)).toBe(true);
  });
});

describe('normalizeText', () => {
  it('collapses whitespace', () => {
    expect(normalizeText('  hello\n  world  ')).toBe('hello world');
    expect(normalizeText(undefined)).toBe('');
  });
});
