/**
 * Tests for the HTML → ReplicaSpec extractor (src/replica/extractHtmlSpec.ts).
 *
 * - rawDomToReplicaSpec is exercised as a pure function on synthetic raw trees
 *   (no browser needed).
 * - extractHtmlToReplicaSpec runs against the real C5 fixture HTML through
 *   headless Chromium (skipped automatically when no browser is available).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { rawDomToReplicaSpec, extractHtmlToReplicaSpec, type RawDomResult, type RawDomNode } from '../../src/replica/extractHtmlSpec';

function node(partial: Partial<RawDomNode> & { tag: string }): RawDomNode {
  return {
    rect: { x: 0, y: 0, width: 100, height: 50 },
    style: {},
    children: [],
    ...partial,
  };
}

function raw(sections: RawDomNode[], extra: Partial<RawDomResult> = {}): RawDomResult {
  return {
    viewport: { width: 1024, height: 1470 },
    pageHeight: 1470,
    fonts: [],
    warnings: [],
    pageBackground: { body: {}, html: {} },
    sections: sections.map((root) => ({ root })),
    ...extra,
  };
}

describe('rawDomToReplicaSpec (pure mapping)', () => {
  it('maps text leaves with computed typography and generic-family fallback', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: { backgroundColor: 'rgb(1, 2, 7)' },
          children: [
            node({
              tag: 'div',
              rect: { x: 10, y: 20, width: 200, height: 40 },
              text: 'Hello',
              style: {
                color: 'rgba(255, 255, 255, 0.5)',
                fontFamily: '-apple-system, Helvetica Neue, Arial, sans-serif',
                fontWeight: '600',
                fontSize: '36px',
                lineHeight: '40px',
                letterSpacing: '-0.3px',
                textAlign: 'center',
              },
            }),
          ],
        }),
      ]),
    );
    expect(spec.source).toBe('html');
    expect(spec.canvas.background).toBe('#010207');
    // body background moved to the canvas, not duplicated on the section.
    expect(spec.sections[0].style.backgroundColor).toBeUndefined();
    const text = spec.sections[0].elements[0].children![0];
    expect(text.type).toBe('text');
    expect(text.style.fontFamily).toBe('Inter'); // generic family mapped
    expect(text.style.fontWeight).toBe(600);
    expect(text.style.fontSize).toBe(36);
    expect(text.style.lineHeight).toBe(40);
    expect(text.style.letterSpacing).toBeCloseTo(-0.3);
    expect(text.style.textAlign).toBe('center');
    expect(text.style.color).toBe('#ffffff');
    expect(text.style.colorAlpha).toBeCloseTo(0.5);
  });

  it('extracts uniform and four-corner borderRadius', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({ tag: 'div', id: 'a', style: { backgroundColor: 'rgb(10,10,10)', borderRadius: ['7px', '7px', '7px', '7px'] } }),
            node({ tag: 'div', id: 'b', style: { backgroundColor: 'rgb(10,10,10)', borderRadius: ['36px', '36px', '0px', '0px'] } }),
          ],
        }),
      ]),
    );
    const [a, b] = spec.sections[0].elements[0].children!;
    expect(a.style.borderRadius).toBe(7);
    expect(b.style.borderRadius).toEqual([36, 36, 0, 0]);
  });

  it('extracts uniform borders and warns on non-uniform ones', () => {
    const warnings: string[] = [];
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              id: 'ok',
              style: {
                borderWidth: ['2px', '2px', '2px', '2px'],
                borderColor: ['rgb(74, 70, 88)', 'rgb(74, 70, 88)', 'rgb(74, 70, 88)', 'rgb(74, 70, 88)'],
                borderStyle: ['solid', 'solid', 'solid', 'solid'],
              },
            }),
            node({
              tag: 'div',
              id: 'uneven',
              style: {
                borderWidth: ['1px', '4px', '1px', '1px'],
                borderColor: ['rgb(0,0,0)', 'rgb(255,0,0)', 'rgb(0,0,0)', 'rgb(0,0,0)'],
                borderStyle: ['solid', 'solid', 'solid', 'solid'],
              },
            }),
          ],
        }),
      ]),
      { warnings },
    );
    const [ok, uneven] = spec.sections[0].elements[0].children!;
    expect(ok.style.border).toEqual({ color: '#4a4658', width: 2, style: 'solid' });
    expect(uneven.style.border).toMatchObject({ color: '#ff0000', width: 4 });
    expect(warnings.some((w) => w.includes('non-uniform border'))).toBe(true);
  });

  it('keeps boxShadow as a CSS string and opacity as a number', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              style: {
                backgroundColor: 'rgb(131, 62, 233)',
                boxShadow: 'rgba(0, 0, 0, 0.5) 0px 4px 12px 2px, rgb(1,1,1) 0px 1px 2px 0px inset',
                opacity: '0.8',
              },
            }),
          ],
        }),
      ]),
    );
    const el = spec.sections[0].elements[0].children![0];
    expect(el.style.boxShadow).toContain('0px 4px 12px');
    expect(el.style.boxShadow).toContain('inset');
    expect(el.style.opacity).toBeCloseTo(0.8);
  });

  it('maps img → image asset (resolved URL) and svg → svg data-url asset', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({ tag: 'img', className: 'art', src: 'file:///tmp/page/album-art.png', rect: { x: 0, y: 0, width: 100, height: 100 } }),
            node({ tag: 'svg', className: 'dots', svg: '<svg viewBox="0 0 8 39"><circle cx="4" cy="4" r="4"/></svg>' }),
          ],
        }),
      ]),
    );
    const [img, svg] = spec.sections[0].elements[0].children!;
    expect(img.type).toBe('image');
    expect(svg.type).toBe('svg');
    const imgAsset = spec.assets.find((a) => a.id === img.assetId)!;
    expect(imgAsset.kind).toBe('image');
    expect(imgAsset.url).toBe('file:///tmp/page/album-art.png');
    expect(imgAsset.fileName).toBe('album-art.png');
    const svgAsset = spec.assets.find((a) => a.id === svg.assetId)!;
    expect(svgAsset.kind).toBe('svg');
    expect(svgAsset.url!.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('recurses nested containers and marks overflow:hidden as clipsContent', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              className: 'art',
              overflow: 'hidden',
              rect: { x: 149, y: 182, width: 722, height: 720 },
              style: { borderRadius: ['30px', '30px', '30px', '30px'] },
              children: [
                node({ tag: 'img', src: 'file:///tmp/x.png', rect: { x: 149, y: 182, width: 722, height: 720 } }),
              ],
            }),
          ],
        }),
      ]),
    );
    const art = spec.sections[0].elements[0].children![0];
    expect(art.type).toBe('frame');
    expect(art.clipsContent).toBe(true);
    expect(art.style.borderRadius).toBe(30);
    expect(art.children).toHaveLength(1);
    expect(art.children![0].type).toBe('image');
    // rects stay page-absolute in the spec; the importer relativizes.
    expect(art.children![0].rect.x).toBe(149);
  });

  it('button-like boxes (visible box + own text) become frame + synthetic label child', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'button',
              text: 'Play',
              style: { backgroundColor: 'rgb(131,62,233)', borderRadius: ['8px', '8px', '8px', '8px'], color: 'rgb(255,255,255)', fontWeight: '700' },
            }),
          ],
        }),
      ]),
    );
    const btn = spec.sections[0].elements[0].children![0];
    expect(btn.type).toBe('frame');
    expect(btn.style.backgroundColor).toBe('#833ee9');
    expect(btn.children).toHaveLength(1);
    expect(btn.children![0].type).toBe('text');
    expect(btn.children![0].text).toBe('Play');
    expect(btn.children![0].style.fontWeight).toBe(700);
  });

  it('synthetic labels use the measured text span (textRect) over the container rect', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'button',
              text: 'Add',
              rect: { x: 244, y: 846, width: 86, height: 40 },
              // The browser-measured glyph span (icon shares the button, so the
              // text is right-of-center and much shorter than the button).
              textRect: { x: 287, y: 857, width: 26, height: 16 },
              style: { backgroundColor: 'rgb(255,255,255)', borderWidth: ['1px', '1px', '1px', '1px'], borderColor: ['rgb(0,0,0)', 'rgb(0,0,0)', 'rgb(0,0,0)', 'rgb(0,0,0)'], borderStyle: ['solid', 'solid', 'solid', 'solid'], fontSize: '14px', lineHeight: '15px', textAlign: 'center' },
              children: [
                node({ tag: 'svg', rect: { x: 259, y: 854, width: 24, height: 24 }, style: {}, svg: '<svg/>' }),
              ],
            }),
          ],
        }),
      ]),
    );
    const btn = spec.sections[0].elements[0].children![0];
    const label = btn.children!.find((c) => c.type === 'text')!;
    // Measured span, not the full 86×40 button rect…
    expect(label.rect).toEqual({ x: 287, y: 857, width: 26, height: 16 });
    // …which also fixes the line-count heuristic: 16/15 = 1.07 → single-line.
    expect(label.textAutoResize).toBe('WIDTH_AND_HEIGHT');
    // Fallback: without textRect the label spans the container (legacy shape).
    const spec2 = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'button',
              text: 'Add',
              rect: { x: 244, y: 846, width: 86, height: 40 },
              style: { backgroundColor: 'rgb(255,255,255)', fontSize: '14px', lineHeight: '15px', textAlign: 'center' },
            }),
          ],
        }),
      ]),
    );
    const label2 = spec2.sections[0].elements[0].children![0].children![0];
    expect(label2.rect).toEqual({ x: 244, y: 846, width: 86, height: 40 });
  });

  it('leaf with background-image url() becomes an image element; gradients stay fills', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({ tag: 'div', id: 'bg-img', style: { backgroundImage: 'url("file:///tmp/hero.png")' } }),
            node({ tag: 'div', id: 'grad', style: { backgroundImage: 'linear-gradient(180deg, rgb(13, 13, 33) 0%, rgb(13, 14, 32) 100%)' } }),
          ],
        }),
      ]),
    );
    const [bgImg, grad] = spec.sections[0].elements[0].children!;
    expect(bgImg.type).toBe('image');
    expect(spec.assets.find((a) => a.id === bgImg.assetId)?.url).toBe('file:///tmp/hero.png');
    expect(grad.type).toBe('frame');
    expect(grad.style.backgroundImage).toContain('linear-gradient');
  });

  it('normalizes canvas origin to (0,0) and sizes canvas from content bounds', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          rect: { x: 8, y: 8, width: 1024, height: 1470 },
          style: {},
          children: [node({ tag: 'div', rect: { x: 108, y: 977, width: 10, height: 10 }, style: { backgroundColor: 'rgb(1,1,1)' } })],
        }),
      ]),
    );
    expect(spec.canvas.width).toBe(1024);
    expect(spec.canvas.height).toBe(1470);
    expect(spec.sections[0].rect).toMatchObject({ x: 0, y: 0 });
    expect(spec.sections[0].elements[0].children![0].rect).toMatchObject({ x: 100, y: 969 });
  });
});

describe('extractHtmlToReplicaSpec (playwright, real C5 fixture)', () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'extract-c5.html');

  it('extracts a spec covering the C5 music player layout', async () => {
    const { spec, warnings } = await extractHtmlToReplicaSpec({
      htmlPath: fixture,
      viewport: { width: 1024, height: 1470 },
    });
    expect(warnings).toEqual([]);
    expect(spec.canvas.width).toBe(1024);
    expect(spec.canvas.height).toBe(1470);
    expect(spec.canvas.background).toBe('#010207');
    expect(spec.sections).toHaveLength(1);

    const root = spec.sections[0].elements[0];
    const flat: Array<(typeof root)> = [];
    const visit = (el: (typeof root)) => {
      flat.push(el);
      el.children?.forEach(visit);
    };
    visit(root);
    const byName = (n: string) => flat.find((e) => e.name === n);

    // sheet: gradient + top-only radius
    const sheet = byName('sheet')!;
    expect(sheet.style.backgroundImage).toContain('linear-gradient');
    expect(sheet.style.borderRadius).toEqual([36, 36, 0, 0]);

    // status bar text
    const time = byName('sb-time')!;
    expect(time.type).toBe('text');
    expect(time.text).toBe('9:41');
    expect(time.style.fontWeight).toBe(600);
    expect(time.style.fontSize).toBe(36);

    // heart button: 2px border + 50% radius
    const heart = byName('heart-btn')!;
    expect(heart.style.border).toMatchObject({ width: 2, style: 'solid' });
    expect(heart.style.borderRadius).toBeGreaterThanOrEqual(40);

    // album art: nested img inside a clipped, rounded container
    const art = byName('art')!;
    expect(art.clipsContent).toBe(true);
    expect(art.style.borderRadius).toBe(30);
    const artImg = art.children![0];
    expect(artImg.type).toBe('image');
    const artAsset = spec.assets.find((a) => a.id === artImg.assetId)!;
    expect(artAsset.url).toContain('album-art.png');
    expect(artAsset.url!.startsWith('file://')).toBe(true); // relative src resolved

    // inline SVGs rasterized to transparent PNGs (2x), vector kept in vectorUrl
    const rasterIcons = flat.filter((e) => e.type === 'image' && spec.assets.find((a) => a.id === e.assetId)?.vectorUrl);
    expect(rasterIcons.length).toBeGreaterThanOrEqual(8);
    for (const icon of rasterIcons) {
      const asset = spec.assets.find((a) => a.id === icon.assetId)!;
      expect(asset.kind).toBe('image');
      expect(asset.url!.startsWith('data:image/png')).toBe(true);
      expect(asset.vectorUrl!.startsWith('data:image/svg+xml')).toBe(true);
    }
    // no vector-only svg elements remain
    expect(flat.filter((e) => e.type === 'svg')).toHaveLength(0);

    // play button circle
    const play = byName('play')!;
    expect(play.style.backgroundColor).toBe('#833ee9');
    expect(play.style.borderRadius).toBeGreaterThanOrEqual(80);
  }, 30000);
});

describe('P0/P1/P2 fixes (pure mapping)', () => {
  it('P0: rasterized svg → image asset with PNG data URL + vectorUrl meta', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const png2 = 'data:image/png;base64,iVBORw0KGgoA=';
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({ tag: 'svg', className: 'chevron', svg: '<svg viewBox="0 0 1 1"></svg>', rasterPng: png }),
            node({ tag: 'img', className: 'icon-file', src: 'file:///tmp/icon.svg', rasterPng: png2 }),
          ],
        }),
      ]),
    );
    const [chevron, iconFile] = spec.sections[0].elements[0].children!;
    expect(chevron.type).toBe('image');
    const a1 = spec.assets.find((a) => a.id === chevron.assetId)!;
    expect(a1.kind).toBe('image');
    expect(a1.url).toBe(png);
    expect(a1.vectorUrl!.startsWith('data:image/svg+xml')).toBe(true);
    expect(iconFile.type).toBe('image');
    const a2 = spec.assets.find((a) => a.id === iconFile.assetId)!;
    expect(a2.url).toBe(png2);
    expect(a2.vectorUrl).toBe('file:///tmp/icon.svg');
  });

  it('P0: non-rasterized svg keeps the legacy svg-element path', () => {
    const spec = rawDomToReplicaSpec(
      raw([node({ tag: 'body', style: {}, children: [node({ tag: 'svg', className: 'dots', svg: '<svg/>' })] })]),
    );
    const dots = spec.sections[0].elements[0].children![0];
    expect(dots.type).toBe('svg');
    expect(spec.assets.find((a) => a.id === dots.assetId)?.url!.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('P1: single-line text gets WIDTH_AND_HEIGHT, multi-line gets HEIGHT, nowrap stays single', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({ tag: 'div', id: 'single', text: 'Midnight Drive', rect: { x: 0, y: 0, width: 380, height: 60 }, style: { fontSize: '55px', lineHeight: '60px', whiteSpace: 'normal' } }),
            node({ tag: 'div', id: 'multi', text: 'A long paragraph that wraps onto multiple lines in the layout.', rect: { x: 0, y: 0, width: 300, height: 120 }, style: { fontSize: '20px', lineHeight: '28px', whiteSpace: 'normal' } }),
            node({ tag: 'div', id: 'nowrap', text: 'no wrap', rect: { x: 0, y: 0, width: 200, height: 30 }, style: { fontSize: '20px', whiteSpace: 'nowrap' } }),
          ],
        }),
      ]),
    );
    const [single, multi, nowrap] = spec.sections[0].elements[0].children!;
    expect(single.textAutoResize).toBe('WIDTH_AND_HEIGHT');
    expect(multi.textAutoResize).toBe('HEIGHT'); // 120/28 ≈ 4.3 lines
    expect(nowrap.textAutoResize).toBe('WIDTH_AND_HEIGHT');
  });

  it('right-flush single-line text is flagged anchorRight; centered/full-width/non-flush/multi-line are not', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              id: 'card',
              rect: { x: 987, y: 0, width: 373, height: 200 },
              style: { backgroundColor: 'rgb(255, 255, 255)' },
              children: [
                // Right edge flush with the card (987+373 = 1360) → anchorRight.
                node({ tag: 'p', id: 'price', text: '$1,615', rect: { x: 1316, y: 10, width: 44, height: 22 }, style: { fontSize: '16px', lineHeight: '22px', textAlign: 'start' } }),
                // 3px gap is within tolerance → anchorRight.
                node({ tag: 'p', id: 'ship', text: 'FREE', rect: { x: 1320, y: 40, width: 37, height: 22 }, style: { fontSize: '16px', lineHeight: '22px', textAlign: 'start' } }),
                // Center-aligned flush text: the anchor is the center, not the right edge.
                node({ tag: 'p', id: 'centered', text: 'mid', rect: { x: 1290, y: 70, width: 70, height: 22 }, style: { fontSize: '16px', lineHeight: '22px', textAlign: 'center' } }),
                // Near-full-width flush text (≥90% of parent) — synthetic-label shape, excluded.
                node({ tag: 'p', id: 'wide', text: 'wide label', rect: { x: 997, y: 100, width: 360, height: 22 }, style: { fontSize: '16px', lineHeight: '22px', textAlign: 'start' } }),
                // Not flush (20px gap).
                node({ tag: 'p', id: 'loose', text: 'loose', rect: { x: 1250, y: 130, width: 90, height: 22 }, style: { fontSize: '16px', lineHeight: '22px', textAlign: 'start' } }),
                // Multi-line flush text: fixed width, no rightward growth → no anchor needed.
                node({ tag: 'p', id: 'para', text: 'wrapped', rect: { x: 1193, y: 150, width: 167, height: 60 }, style: { fontSize: '16px', lineHeight: '22px', textAlign: 'start' } }),
              ],
            }),
          ],
        }),
      ]),
    );
    const card = spec.sections[0].elements[0].children![0];
    const byId = (id: string) => card.children!.find((c) => c.key.includes(id) || c.name === id)!;
    expect(byId('price').anchorRight).toBe(true);
    expect(byId('ship').anchorRight).toBe(true);
    expect(byId('centered').anchorRight).toBeUndefined();
    expect(byId('wide').anchorRight).toBeUndefined();
    expect(byId('loose').anchorRight).toBeUndefined();
    expect(byId('para').anchorRight).toBeUndefined();
  });

  it('P2: html background paints the canvas when body is transparent', () => {
    const spec = rawDomToReplicaSpec(
      raw([node({ tag: 'body', style: { backgroundColor: 'rgba(0, 0, 0, 0)' } })], {
        pageBackground: { body: { color: 'rgba(0, 0, 0, 0)', image: 'none' }, html: { color: 'rgb(13, 13, 20)', image: 'none' } },
      }),
    );
    expect(spec.canvas.background).toBe('#0d0d14');
  });

  it('P2: body wins over html; gradients land in canvas.backgroundImage', () => {
    const grad = 'linear-gradient(180deg, rgb(13, 13, 33) 0%, rgb(13, 14, 32) 100%)';
    const spec = rawDomToReplicaSpec(
      raw([node({ tag: 'body', style: { backgroundImage: grad } })], {
        pageBackground: { body: { color: 'rgba(0, 0, 0, 0)', image: grad }, html: { color: 'rgb(255, 0, 0)', image: 'none' } },
      }),
    );
    expect(spec.canvas.background).toBeUndefined(); // transparent base under the gradient
    expect(spec.canvas.backgroundImage).toContain('linear-gradient');
    expect(spec.canvas.background).not.toBe('#ff0000'); // html loses
    // gradient stripped from the body section (moved to canvas)
    expect(spec.sections[0].style.backgroundImage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Optimization round: tracker/broken/tiny img filtering, rasterizeRaster,
// styled runs, hidden pruning, container collapse, extraction cache.
// ---------------------------------------------------------------------------

describe('container collapsing (pure mapping)', () => {
  it('merges style-less single-child container chains and drops empty style-less leaves', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              className: 'outer',
              style: {},
              children: [
                node({
                  tag: 'div',
                  className: 'inner',
                  style: {},
                  children: [node({ tag: 'div', className: 'card', style: { backgroundColor: 'rgb(10,10,10)' } })],
                }),
              ],
            }),
            node({ tag: 'div', className: 'ghost', style: {} }),
          ],
        }),
      ]),
    );
    const kids = spec.sections[0].elements[0].children!;
    // outer/inner collapsed into card; ghost dropped entirely.
    expect(kids).toHaveLength(1);
    expect(kids[0].name).toBe('card');
    expect(kids[0].style.backgroundColor).toBe('#0a0a0a');
  });

  it('clipping flags survive the merge', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              className: 'clipper',
              overflow: 'hidden',
              style: {},
              children: [node({ tag: 'div', className: 'card', style: { backgroundColor: 'rgb(1,1,1)' } })],
            }),
          ],
        }),
      ]),
    );
    const card = spec.sections[0].elements[0].children![0];
    expect(card.name).toBe('card');
    expect(card.clipsContent).toBe(true);
  });

  it('collapseContainers:false preserves the legacy tree', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [node({ tag: 'div', className: 'ghost', style: {} })],
        }),
      ]),
      { collapseContainers: false },
    );
    expect(spec.sections[0].elements[0].children).toHaveLength(1);
  });
});

describe('styled runs mapping (pure)', () => {
  it('maps raw runs to spec runs and drops them when uniform with the base style', () => {
    const withRuns = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'p',
              text: 'Hello bold world',
              style: { color: 'rgb(255,255,255)', fontFamily: 'Inter', fontWeight: '400', fontSize: '16px' },
              runs: [
                { text: 'Hello ', style: { color: 'rgb(255,255,255)', fontFamily: 'Inter', fontWeight: '400' } },
                { text: 'bold', style: { color: 'rgb(255,255,255)', fontFamily: 'Inter', fontWeight: '700' } },
                { text: ' world', style: { color: 'rgb(255,0,0)', fontFamily: 'Inter', fontWeight: '400' } },
              ],
            }),
          ],
        }),
      ]),
    );
    const text = withRuns.sections[0].elements[0].children![0];
    expect(text.type).toBe('text');
    expect(text.runs).toHaveLength(3);
    expect(text.runs![1].fontWeight).toBe(700);
    expect(text.runs![2].color).toBe('#ff0000');
    expect(text.text).toBe('Hello bold world');

    const uniform = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'p',
              text: 'all same',
              style: { color: 'rgb(255,255,255)', fontFamily: 'Inter', fontWeight: '400', fontSize: '16px' },
              runs: [
                { text: 'all ', style: { color: 'rgb(255,255,255)', fontFamily: 'Inter', fontWeight: '400' } },
                { text: 'same', style: { color: 'rgb(255,255,255)', fontFamily: 'Inter', fontWeight: '400' } },
              ],
            }),
          ],
        }),
      ]),
    );
    expect(uniform.sections[0].elements[0].children![0].runs).toBeUndefined();
  });
});

describe('extractHtmlToReplicaSpec — optimization round (playwright, inline html)', () => {
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const WEBP_1PX = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';

  const flatOf = (spec: any) => {
    const flat: any[] = [];
    const visit = (el: any) => {
      flat.push(el);
      el.children?.forEach(visit);
    };
    spec.sections.forEach((s: any) => s.elements.forEach(visit));
    return flat;
  };

  it('skips tracker hosts, broken images and 1×1 tracking pixels; keeps scaled 1px images', async () => {
    const html = `<html><body style="margin:0">
      <img src="https://doubleclick.net/ad/x.png" width="10" height="10" alt="">
      <img src="https://definitely.invalid/nowhere.png" width="10" height="10" alt="">
      <img src="${PNG_1PX}" width="1" height="1" alt="">
      <img id="big" src="${PNG_1PX}" width="100" height="100" alt="">
    </body></html>`;
    const { spec, warnings } = await extractHtmlToReplicaSpec({ html, cache: false });
    const images = flatOf(spec).filter((e) => e.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].rect.width).toBe(100);
    // tracker dropped silently; the broken one warns exactly once.
    expect(warnings.filter((w) => w.includes('img failed to load'))).toHaveLength(1);
    expect(warnings.some((w) => w.includes('doubleclick'))).toBe(false);
  }, 30000);

  it('prunes elements fully clipped by an overflow ancestor; includeHidden keeps them', async () => {
    const html = `<html><body style="margin:0">
      <div style="overflow:hidden;width:100px;height:100px">
        <div id="visible-slide" style="width:100px;height:100px;background:#111"></div>
        <div id="hidden-slide" style="width:100px;height:100px;background:#222;margin-left:500px"></div>
      </div>
    </body></html>`;
    const pruned = await extractHtmlToReplicaSpec({ html, cache: false });
    const names = flatOf(pruned.spec).map((e) => e.name);
    expect(names).toContain('visible-slide');
    expect(names).not.toContain('hidden-slide');

    const kept = await extractHtmlToReplicaSpec({ html, includeHidden: true, cache: false });
    expect(flatOf(kept.spec).map((e) => e.name)).toContain('hidden-slide');
  }, 30000);

  it('rasterizeRaster: webp <img> becomes a 2x PNG asset with originalUrl fallback', async () => {
    const html = `<html><body style="margin:0">
      <img src="${WEBP_1PX}" style="width:120px;height:80px" alt="">
    </body></html>`;
    const { spec } = await extractHtmlToReplicaSpec({ html, cache: false });
    const images = flatOf(spec).filter((e) => e.type === 'image');
    expect(images).toHaveLength(1);
    const asset = spec.assets.find((a: any) => a.id === images[0].assetId)!;
    expect(asset.url.startsWith('data:image/png')).toBe(true);
    expect(asset.originalUrl).toBe(WEBP_1PX);

    const off = await extractHtmlToReplicaSpec({ html, rasterizeRaster: false, cache: false });
    const offImages = flatOf(off.spec).filter((e) => e.type === 'image');
    const offAsset = off.spec.assets.find((a: any) => a.id === offImages[0].assetId)!;
    expect(offAsset.url).toBe(WEBP_1PX);
    expect(offAsset.originalUrl).toBeUndefined();
  }, 30000);

  it('styled runs: inline formatting children merge into one text element with styled runs', async () => {
    const html = `<html><body style="margin:0">
      <p style="font-family:sans-serif;font-size:20px;color:#ffffff;margin:0">
        Price <strong style="font-weight:700">$12</strong> <a href="#" style="color:#ff0000">buy now</a>
      </p>
    </body></html>`;
    const { spec } = await extractHtmlToReplicaSpec({ html, cache: false });
    const texts = flatOf(spec).filter((e) => e.type === 'text');
    expect(texts).toHaveLength(1);
    const t = texts[0];
    expect(t.runs?.length).toBeGreaterThanOrEqual(3);
    // run-boundary whitespace preserved (no collapse across runs)
    expect(t.text).toContain('Price ');
    expect(t.text).toContain(' buy now');
    const bold = t.runs.find((r: any) => r.text.includes('$12'))!;
    expect(bold.fontWeight).toBe(700);
    const link = t.runs.find((r: any) => r.text.includes('buy now'))!;
    expect(link.color).toBe('#ff0000');
    // block coordinates come from the element rect
    expect(t.rect.width).toBeGreaterThan(0);
  }, 30000);

  it('extraction cache: a second identical call is served from memory', async () => {
    const html = '<html><body><p>cache me</p></body></html>';
    const file = path.join(__dirname, '..', 'fixtures', 'extract-cache-tmp.html');
    const fs = await import('node:fs');
    fs.writeFileSync(file, html);
    try {
      const a = await extractHtmlToReplicaSpec({ htmlPath: file });
      const b = await extractHtmlToReplicaSpec({ htmlPath: file });
      expect(b).toBe(a); // same object → cache hit
      const { clearExtractHtmlCache } = await import('../../src/replica/extractHtmlSpec');
      clearExtractHtmlCache();
      const c = await extractHtmlToReplicaSpec({ htmlPath: file });
      expect(c).not.toBe(a);
      expect(c.spec.canvas.width).toBe(a.spec.canvas.width);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }, 60000);
});

describe('collapse + clipsContent box semantics', () => {
  it('a LARGER overflow:hidden wrapper survives collapse instead of shrinking its clip box onto the child', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              className: 'wide-clipper',
              overflow: 'hidden',
              rect: { x: 0, y: 0, width: 1440, height: 1776 },
              style: {},
              children: [
                node({
                  tag: 'div',
                  className: 'narrow-grid',
                  rect: { x: 80, y: 124, width: 1280, height: 1310 },
                  style: {},
                  children: [
                    node({
                      tag: 'div',
                      className: 'card',
                      rect: { x: 955, y: 124, width: 405, height: 1310 },
                      style: { backgroundColor: 'rgb(245,247,252)', boxShadow: 'rgb(245, 247, 252) 400px 0px 0px 400px' },
                      children: [node({ tag: 'div', className: 'inner', rect: { x: 987, y: 150, width: 20, height: 20 }, style: { backgroundColor: 'rgb(1,1,1)' } })],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ]),
    );
    const root = spec.sections[0].elements[0];
    // The 1440-wide clipping wrapper must still exist as its own frame…
    const clipper = root.children!.find((c) => c.name === 'wide-clipper')!;
    expect(clipper).toBeDefined();
    expect(clipper.clipsContent).toBe(true);
    // …and nothing inside inherits the clip: the style-less grid collapses
    // into the card, and the card must stay unclipped so its 400px shadow
    // paints past the grid's right edge up to 1440.
    const card = clipper.children!.find((c) => c.name === 'card')!;
    expect(card.clipsContent).toBeUndefined();
    expect(card.style.boxShadow).toContain('400px');
  });

  it('same-box clipping wrapper still collapses and propagates clipsContent', () => {
    const spec = rawDomToReplicaSpec(
      raw([
        node({
          tag: 'body',
          style: {},
          children: [
            node({
              tag: 'div',
              className: 'clipper',
              overflow: 'hidden',
              rect: { x: 10, y: 10, width: 200, height: 100 },
              style: {},
              children: [
                node({
                  tag: 'div',
                  className: 'same-box',
                  rect: { x: 10, y: 10, width: 200, height: 100 },
                  style: { backgroundColor: 'rgb(9,9,9)' },
                  children: [node({ tag: 'div', className: 'inner', rect: { x: 20, y: 20, width: 20, height: 20 }, style: { backgroundColor: 'rgb(1,1,1)' } })],
                }),
              ],
            }),
          ],
        }),
      ]),
    );
    const merged = spec.sections[0].elements[0].children![0];
    expect(merged.name).toBe('same-box');
    expect(merged.clipsContent).toBe(true);
  });
});

describe('extractHtmlToReplicaSpec (playwright, shadow-bleed regression)', () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'shadow-bleed.html');

  it('viewport-bleed shadow: only the viewport-wide clipper clips; grid and card stay open', async () => {
    const { spec } = await extractHtmlToReplicaSpec({ htmlPath: fixture, viewport: { width: 1000, height: 600 } });
    type El = (typeof spec.sections)[number]['elements'][number];
    const flat: El[] = [];
    const visit = (el: El) => { flat.push(el); el.children?.forEach(visit); };
    spec.sections.forEach((s) => s.elements.forEach(visit));

    const byName = (n: string) => flat.find((e) => e.name?.includes(n));
    // Card keeps its shadow and its background…
    const card = byName('card')!;
    expect(card).toBeDefined();
    expect(card.style.boxShadow).toContain('300px');
    expect(card.clipsContent).toBeUndefined();
    // …and the ONLY clipping frame anywhere is the viewport-wide wrapper
    // (the style-less narrower grid collapses away and must not inherit the
    // clip — that was the bug that killed the shadow at the grid's edge).
    const page = byName('page')!;
    expect(page.clipsContent).toBe(true);
    expect(page.rect.width).toBe(1000);
    const clippers = flat.filter((e) => e.clipsContent);
    expect(clippers.map((c) => c.name)).toEqual([page.name]);
    // Overflowing nowrap text is preserved with its content.
    const line = byName('overflow-line')!;
    expect(line.text ?? line.children?.[0]?.text).toContain('See if you qualify');
  }, 60000);
});
