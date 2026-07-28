import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { simplifyNode, simplifiedToCompact, metadataNode, metadataToXml, rgbToHex } from '../../src/figma/simplify';

const file = JSON.parse(fs.readFileSync(new URL('../fixtures/file.json', import.meta.url), 'utf8'));
const page = file.document.children[0];
const mainFrame = page.children[0];

describe('simplifyNode', () => {
  const s = simplifyNode(mainFrame);

  it('keeps absolute bounds', () => {
    expect(s.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    const hero = s.children![1];
    expect(hero.name).toBe('Hero');
    expect(hero.bounds.y).toBe(64);
  });

  it('captures auto-layout', () => {
    const header = s.children![0];
    expect(header.layout).toMatchObject({ mode: 'row', gap: 24, alignPrimary: 'SPACE_BETWEEN', alignCounter: 'CENTER' });
    expect(header.layout?.padding).toEqual({ top: 16, right: 32, bottom: 16, left: 32 });
    const hero = s.children![1];
    expect(hero.layout?.mode).toBe('column');
  });

  it('simplifies solid fills to hex + alpha', () => {
    const header = s.children![0];
    expect(header.fills?.[0]).toMatchObject({ type: 'solid', color: '#f5f7fa', alpha: 1 });
    const btn = s.children![1].children![2];
    expect(btn.fills?.[0].color).toBe('#005a88');
  });

  it('simplifies gradients with stops', () => {
    const hero = s.children![1];
    expect(hero.fills?.[0].type).toBe('gradient_linear');
    expect(hero.fills?.[0].stops?.[0]).toMatchObject({ position: 0, color: '#f0f7fc' });
  });

  it('keeps image fill refs', () => {
    const shot = s.children![2];
    expect(shot.type).toBe('RECTANGLE');
    expect(shot.fills?.[0]).toMatchObject({ type: 'image', imageRef: 'abc123hash', scaleMode: 'FILL' });
  });

  it('captures text styles', () => {
    const headline = s.children![1].children![0];
    expect(headline.text).toMatchObject({
      characters: 'Build faster with ACME',
      fontFamily: 'Inter',
      fontWeight: 700,
      fontSize: 56,
      letterSpacingPx: -1,
      lineHeightPx: 64,
    });
    const logo = s.children![0].children![0];
    expect(logo.text?.textCase).toBe('UPPER');
  });

  it('respects depth truncation', () => {
    const shallow = simplifyNode(mainFrame, { depth: 1 });
    expect(shallow.childrenTruncated).toBe(mainFrame.children.length);
    expect(shallow.children).toBeUndefined();
  });

  it('compact format renders one line per node', () => {
    const compact = simplifiedToCompact(s);
    expect(compact).toContain('FRAME "Hero" #1:10');
    expect(compact).toContain('layout=column');
    expect(compact).toContain('font=Inter');
  });
});

describe('metadata', () => {
  it('projects a light tree and XML', () => {
    const m = metadataNode(mainFrame);
    expect(m.type).toBe('FRAME');
    expect(m.children?.length).toBe(mainFrame.children.length);
    const xml = metadataToXml(m);
    expect(xml).toContain('<node id="1:2" name="Landing Page" type="FRAME"');
    expect(xml).toContain('name="icon/check" type="VECTOR"');
    expect(xml).toContain('</node>');
  });

  it('escapes xml attributes', () => {
    const xml = metadataToXml({ id: '1', name: 'a "b" <c>', type: 'FRAME', bounds: { x: 0, y: 0, width: 1, height: 1 } });
    expect(xml).toContain('name="a &quot;b&quot; &lt;c&gt;"');
  });
});

describe('rgbToHex', () => {
  it('converts and clamps', () => {
    expect(rgbToHex({ r: 0, g: 0.353, b: 0.533 })).toBe('#005a88');
    expect(rgbToHex(undefined)).toBe('#000000');
  });
});
