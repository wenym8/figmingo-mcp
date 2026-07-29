/**
 * Tests for the import_html_replica importer fixes:
 * borderRadius / border / boxShadow / x-y / nested containers / font
 * fallbacks / SVG rejection / warnings + stats plumbing.
 */
import { describe, it, expect } from 'vitest';
import { makeCtx, jsonOf } from './helpers';
import { buildImportCommands, importHtmlReplica, resolveBatchOutcome, type ImportPlan } from '../../src/tools/write/importHtmlReplica';
import { parseBoxShadow, shadowEffects, fontFallbackChain } from '../../src/replica/css';
import type { ReplicaElement, ReplicaSpec } from '../../src/replica/spec';

let seq = 0;
function el(partial: Partial<ReplicaElement> & { type: ReplicaElement['type']; name: string }): ReplicaElement {
  return {
    key: partial.name,
    nodeId: `n${seq++}`,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    style: {},
    ...partial,
  };
}

function specOf(root: ReplicaElement, extra: Partial<ReplicaSpec> = {}): ReplicaSpec {
  return {
    version: 1,
    source: 'html',
    node: { id: 'html-root', name: 'test-page', type: 'PAGE' },
    canvas: { width: 400, height: 300, background: '#010207' },
    sections: [
      {
        id: root.nodeId,
        name: root.name,
        nodeType: 'ELEMENT',
        rect: root.rect,
        style: root.style,
        elements: [root],
      },
    ],
    assets: [],
    metadata: { generatedAt: new Date().toISOString() },
    ...extra,
  };
}

const png1px = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('css helpers', () => {
  it('parseBoxShadow parses color-first and inset shadows', () => {
    const shadows = parseBoxShadow('rgba(0, 0, 0, 0.5) 0px 4px 12px 2px, rgb(255, 255, 255) 0px 1px 2px 0px inset');
    expect(shadows).toHaveLength(2);
    expect(shadows[0]).toMatchObject({ inset: false, offsetX: 0, offsetY: 4, blur: 12, spread: 2 });
    expect(shadows[0].color.a).toBeCloseTo(0.5);
    expect(shadows[1]).toMatchObject({ inset: true, offsetY: 1, blur: 2 });
    const effects = shadowEffects(shadows);
    expect(effects[0]).toMatchObject({ type: 'DROP_SHADOW', radius: 12, spread: 2 });
    expect(effects[1]).toMatchObject({ type: 'INNER_SHADOW' });
    expect(parseBoxShadow('none')).toEqual([]);
    expect(parseBoxShadow(undefined)).toEqual([]);
  });

  it('fontFallbackChain orders nearest weights first and ends at Regular floor', () => {
    const chain = fontFallbackChain(600);
    expect(chain[0]).toBe('SemiBold');
    expect(chain[1]).toBe('Medium');
    expect(chain).toContain('Regular');
    expect(new Set(chain).size).toBe(chain.length);
    expect(fontFallbackChain(undefined)[0]).toBe('Regular');
  });
});

describe('buildImportCommands (importer fixes)', () => {
  it('passes x/y through to the main frame', async () => {
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, specOf(el({ type: 'frame', name: 'body', rect: { x: 0, y: 0, width: 400, height: 300 } })), {
      x: 960,
      y: 120,
    });
    expect(plan.commands[0].params).toMatchObject({ x: 960, y: 120 });
  });

  it('applies borderRadius (uniform + four-corner), border → strokes, boxShadow → effects', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [
        el({
          type: 'frame',
          name: 'card',
          rect: { x: 10, y: 10, width: 200, height: 100 },
          style: {
            backgroundColor: '#14102e',
            borderRadius: [36, 36, 0, 0],
            border: { color: '#4a4658', width: 2, style: 'solid' },
            boxShadow: 'rgba(0, 0, 0, 0.5) 0px 4px 12px 2px',
          },
        }),
        el({
          type: 'frame',
          name: 'pill',
          rect: { x: 10, y: 120, width: 90, height: 13 },
          style: { backgroundColor: '#47455c', borderRadius: 7 },
        }),
      ],
    });
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, specOf(root));
    // children of a container recurse: body becomes a create_frame with an `as` var
    const bodyFrame = plan.commands.find((c) => c.params?.name === 'body')!;
    expect(bodyFrame.command).toBe('create_frame');
    expect(bodyFrame.as).toBeTruthy();
    const card = plan.commands.find((c) => c.params?.name === 'card')!;
    expect(card.command).toBe('create_rectangle'); // leaf visual box
    expect(card.params?.cornerRadius).toEqual([36, 36, 0, 0]);
    expect(card.params?.strokes).toBeDefined();
    expect(card.params?.strokeWeight).toBe(2);
    expect(card.params?.effects).toMatchObject([{ type: 'DROP_SHADOW', radius: 12, spread: 2 }]);
    expect(card.params?.parentId).toBe(`$${bodyFrame.as}`);
    // coordinates are parent-relative
    expect(card.params).toMatchObject({ x: 10, y: 10 });
    const pill = plan.commands.find((c) => c.params?.name === 'pill')!;
    expect(pill.params?.cornerRadius).toBe(7);
  });

  it('keeps leaf frames with no fills as transparent containers (unless skipped)', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [el({ type: 'frame', name: 'ghost', rect: { x: 5, y: 5, width: 50, height: 50 } })],
    });
    const ctx = makeCtx();
    const keep = await buildImportCommands(ctx, specOf(root));
    const ghost = keep.commands.find((c) => c.params?.name === 'ghost')!;
    expect(ghost.command).toBe('create_frame');
    expect(ghost.params?.fills).toEqual([]);
    const skip = await buildImportCommands(ctx, specOf(root), { skipEmptyFrames: true });
    expect(skip.commands.some((c) => c.params?.name === 'ghost')).toBe(false);
  });

  it('maps fontWeight 600 → Inter SemiBold with a fallbackStyles chain', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [
        el({ type: 'text', name: 't', text: 'hi', rect: { x: 0, y: 0, width: 50, height: 20 }, style: { fontWeight: 600, fontSize: 24, color: '#ffffff' } }),
      ],
    });
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, specOf(root));
    const text = plan.commands.find((c) => c.command === 'create_text')!;
    expect(text.params?.fontName).toEqual({ family: 'Inter', style: 'SemiBold' });
    expect(text.params?.fallbackStyles).toContain('Medium');
    expect(text.params?.fallbackStyles).toContain('Regular');
    expect(text.params?.fallbackStyles).not.toContain('SemiBold');
  });

  it('insert_image carries cornerRadius; data: URL assets decode inline', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [
        el({
          type: 'image',
          name: 'art',
          rect: { x: 20, y: 20, width: 100, height: 100 },
          assetId: 'a0',
          style: { borderRadius: 30 },
        }),
      ],
    });
    const spec = specOf(root);
    spec.assets = [{ id: 'a0', kind: 'image', nodeIds: [], url: `data:image/png;base64,${png1px.toString('base64')}`, fileName: 'a.png' }];
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, spec);
    const img = plan.commands.find((c) => c.command === 'insert_image')!;
    expect(img.params?.cornerRadius).toBe(30);
    expect(img.params?.bytesBase64).toBe(png1px.toString('base64'));
    expect(plan.warnings).toEqual([]);
  });

  it('SVG assets are rejected with a warning + placeholder, never sent to createImage', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [el({ type: 'svg', name: 'chevron', rect: { x: 0, y: 0, width: 36, height: 22 }, assetId: 'a0' })],
    });
    const spec = specOf(root);
    spec.assets = [
      { id: 'a0', kind: 'svg', nodeIds: [], url: `data:image/svg+xml;utf8,${encodeURIComponent('<svg viewBox="0 0 1 1"></svg>')}`, fileName: 'c.svg' },
    ];
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, spec);
    expect(plan.commands.some((c) => c.command === 'insert_image')).toBe(false);
    const placeholder = plan.commands.find((c) => c.params?.name === 'svg:chevron')!;
    expect(placeholder.command).toBe('create_rectangle');
    expect(plan.warnings.some((w) => w.includes('svg "chevron"'))).toBe(true);
  });

  it('failed image downloads warn and fall back to a placeholder', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [el({ type: 'image', name: 'missing', rect: { x: 0, y: 0, width: 10, height: 10 }, assetId: 'a0' })],
    });
    const spec = specOf(root);
    spec.assets = [{ id: 'a0', kind: 'image', nodeIds: [], url: 'file:///definitely/not/here.png', fileName: 'x.png' }];
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, spec);
    expect(plan.warnings.some((w) => w.includes('"missing"') && w.includes('failed to load'))).toBe(true);
    expect(plan.stats.placeholders).toBe(1);
  });
});

describe('resolveBatchOutcome', () => {
  it('counts created nodes and surfaces font degradations + failures as warnings', () => {
    const plan: ImportPlan = {
      commands: [
        { command: 'create_frame', params: { name: 'main' }, as: 'main' },
        { command: 'create_text', params: { fontName: { family: 'Inter', style: 'SemiBold' }, characters: 'Hello world' } },
        { command: 'create_rectangle', params: { name: 'box' } },
      ],
      stats: { sections: 1, texts: 1, images: 0, svgs: 0, backgrounds: 1, containers: 0, placeholders: 0 },
      warnings: ['pre-existing'],
    };
    const outcome = resolveBatchOutcome(plan, {
      results: [
        { index: 0, command: 'create_frame', ok: true, result: { nodeId: '1:1' } },
        { index: 1, command: 'create_text', ok: true, result: { nodeId: '1:2', fontApplied: { family: 'Inter', style: 'Medium' }, fontFallback: 'requested Inter SemiBold unavailable' } },
        { index: 2, command: 'create_rectangle', ok: false, error: 'boom' },
      ],
    });
    expect(outcome.created).toBe(2);
    expect(outcome.warnings).toContain('pre-existing');
    expect(outcome.warnings.some((w) => w.includes('Inter SemiBold → Inter Medium'))).toBe(true);
    expect(outcome.warnings.some((w) => w.includes('#2') && w.includes('boom'))).toBe(true);
  });
});

describe('import_html_replica tool', () => {
  it('requires exactly one source', async () => {
    const ctx = makeCtx();
    await expect(importHtmlReplica.handler(ctx, {})).rejects.toThrow(/exactly one/);
    await expect(importHtmlReplica.handler(ctx, { spec: {}, specPath: '/x.json' })).rejects.toThrow(/exactly one/);
  });

  it('dryRun over an inline spec reports warnings in the payload', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 100, height: 100 },
      children: [el({ type: 'svg', name: 'icon', rect: { x: 0, y: 0, width: 10, height: 10 }, assetId: 'a0' })],
    });
    const spec = specOf(root);
    spec.assets = [{ id: 'a0', kind: 'svg', nodeIds: [], url: 'data:image/svg+xml;utf8,<svg/>', fileName: 'i.svg' }];
    const ctx = makeCtx();
    const res = await importHtmlReplica.handler(ctx, { spec, dryRun: true });
    const parsed = jsonOf(res);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.warnings.some((w: string) => w.includes('svg "icon"'))).toBe(true);
  });
});

describe('P1/P2 importer support', () => {
  it('P1: create_text carries textAutoResize — explicit marker wins, heuristic otherwise', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [
        el({ type: 'text', name: 'marked', text: 'a', rect: { x: 0, y: 0, width: 100, height: 100 }, style: { fontSize: 16 }, textAutoResize: 'NONE' }),
        el({ type: 'text', name: 'single', text: 'b', rect: { x: 0, y: 0, width: 200, height: 40 }, style: { fontSize: 24, lineHeight: 32 } }),
        el({ type: 'text', name: 'multi', text: 'c', rect: { x: 0, y: 0, width: 200, height: 200 }, style: { fontSize: 16, lineHeight: 24 } }),
      ],
    });
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, specOf(root));
    const byName = (n: string) => plan.commands.find((c) => c.params?.name === n)!;
    expect(byName('marked').params?.textAutoResize).toBe('NONE');
    expect(byName('single').params?.textAutoResize).toBe('WIDTH_AND_HEIGHT'); // 40/32 = 1.25 lines
    expect(byName('multi').params?.textAutoResize).toBe('HEIGHT'); // 200/24 ≈ 8.3 lines
  });

  it('P2: canvas gradient becomes the main frame fill', async () => {
    const spec = specOf(el({ type: 'frame', name: 'body', rect: { x: 0, y: 0, width: 400, height: 300 } }));
    spec.canvas.background = undefined;
    spec.canvas.backgroundImage = 'linear-gradient(180deg, #0d0d21 0%, #14102e 42%, #0d0e20 100%)';
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, spec);
    const main = plan.commands[0];
    expect((main.params?.fills as any[])[0].type).toBe('GRADIENT_LINEAR');
    expect((main.params?.fills as any[])[0].gradientStops).toHaveLength(3);
  });

  it('P0: rasterized svg assets (kind image, PNG data URL) insert as real images', async () => {
    const root = el({
      type: 'frame',
      name: 'body',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [el({ type: 'image', name: 'chevron', rect: { x: 0, y: 0, width: 36, height: 22 }, assetId: 'a0' })],
    });
    const spec = specOf(root);
    spec.assets = [
      {
        id: 'a0',
        kind: 'image',
        nodeIds: [],
        url: `data:image/png;base64,${png1px.toString('base64')}`,
        vectorUrl: 'data:image/svg+xml;utf8,%3Csvg%3E',
        fileName: 'chevron.png',
      },
    ];
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, spec);
    expect(plan.commands.some((c) => c.command === 'insert_image' && c.params?.name === 'chevron')).toBe(true);
    expect(plan.warnings).toEqual([]);
    expect(plan.stats.images).toBe(1);
  });
});
