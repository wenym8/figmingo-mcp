import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildReplicaSpec } from '../../src/replica/spec';

const file = JSON.parse(fs.readFileSync(new URL('../fixtures/file.json', import.meta.url), 'utf8'));
const mainFrame = file.document.children[0].children[0];

describe('buildReplicaSpec', () => {
  const spec = buildReplicaSpec(mainFrame, {
    fileKey: 'testFileKey123',
    fileName: file.name,
    imageFills: { abc123hash: 'https://figma-fills.example.com/abc/fill-product.png' },
    renderedNodes: { '1:21': 'https://figma-renders.example.com/abc/render-1-21.svg' },
  });

  it('creates sections from every top-level child (auto)', () => {
    expect(spec.sections.map((s) => s.name)).toEqual(['Header', 'Hero', 'Product Shot', 'icon/check', 'Footer']);
  });

  it('emits absolute rects relative to the canvas origin', () => {
    const hero = spec.sections[1];
    expect(hero.rect).toEqual({ x: 0, y: 64, width: 1440, height: 500 });
    const headline = hero.elements.find((e) => e.nodeId === '1:11');
    expect(headline?.rect).toEqual({ x: 120, y: 144, width: 700, height: 68 });
  });

  it('computes typography in px with text-case', () => {
    const logo = spec.sections[0].elements.find((e) => e.nodeId === '1:4');
    expect(logo?.type).toBe('text');
    expect(logo?.text).toBe('ACME');
    expect(logo?.style).toMatchObject({
      fontFamily: 'Inter',
      fontStyleName: 'Bold',
      fontWeight: 700,
      fontSize: 20,
      letterSpacing: 0.5,
      lineHeight: 24,
      textTransform: 'uppercase',
      color: '#111111',
    });
  });

  it('emits hex colors and css gradient strings', () => {
    const hero = spec.sections[1];
    expect(hero.style.backgroundImage).toContain('linear-gradient(');
    expect(hero.style.backgroundImage).toContain('#f0f7fc');
    const header = spec.sections[0];
    expect(header.style.backgroundColor).toBe('#f5f7fa');
  });

  it('builds an asset manifest with image fills and svg urls', () => {
    const img = spec.assets.find((a) => a.kind === 'image');
    expect(img).toMatchObject({ hash: 'abc123hash', url: 'https://figma-fills.example.com/abc/fill-product.png' });
    const svg = spec.assets.find((a) => a.kind === 'svg');
    expect(svg?.nodeIds).toContain('1:21');
    expect(svg?.url).toContain('.svg');
    const shot = spec.sections.flatMap((s) => s.elements).find((e) => e.nodeId === '1:20');
    expect(shot?.type).toBe('image');
    expect(shot?.assetId).toBe(img?.id);
    const icon = spec.sections.flatMap((s) => s.elements).find((e) => e.nodeId === '1:21');
    expect(icon?.type).toBe('svg');
    expect(icon?.assetHint).toBe('icon');
  });

  it('logo hint is driven by the (parameterized) pattern', () => {
    const withLogo = buildReplicaSpec(mainFrame, { logoPattern: '^Product' });
    const shot = withLogo.sections.flatMap((s) => s.elements).find((e) => e.nodeId === '1:20');
    expect(shot?.assetHint).toBe('logo');
  });

  it('self mode produces a single section', () => {
    const one = buildReplicaSpec(mainFrame, { sections: 'self', includeAssets: false });
    expect(one.sections).toHaveLength(1);
    expect(one.sections[0].name).toBe('Landing Page');
  });

  it('canvas carries size + background', () => {
    expect(spec.canvas).toMatchObject({ width: 1440, height: 900, background: '#ffffff' });
    expect(spec.file?.key).toBe('testFileKey123');
  });
});
