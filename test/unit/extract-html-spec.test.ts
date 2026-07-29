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
