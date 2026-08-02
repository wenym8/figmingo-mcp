/**
 * Unit tests for the plugin sandbox half (plugin/code.ts) with a stubbed
 * `figma` global — no Figma desktop needed. Covers:
 *  - create_rectangle / create_frame `rotation` (degrees → radians)
 *  - batch per-command progress heartbeats + partial results on abort
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

interface PostedMessage {
  type: string;
  id?: string;
  ok?: boolean;
  result?: any;
  error?: string;
  index?: number;
  total?: number;
  command?: string;
}

const posted: PostedMessage[] = [];
const removed: string[] = [];
let onMessage: ((msg: any) => Promise<void>) | undefined;
let nodeSeq = 0;

function makeNode(type: string) {
  const node: any = {
    id: `${type}:${++nodeSeq}`,
    type,
    name: '',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    children: [],
    appendChild(child: any) {
      this.children.push(child);
    },
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    remove() {
      removed.push(this.id);
    },
    setRangeFontName(start: number, end: number, font: any) {
      (this.rangeFonts ||= []).push([start, end, font]);
    },
    setRangeFills(start: number, end: number, fills: any) {
      (this.rangeFills ||= []).push([start, end, fills]);
    },
  };
  if (type === 'TEXT') {
    // Content-driven sizing simulation (Figma's WIDTH_AND_HEIGHT): when the
    // test enables figma.__autoSizeTexts, assigning characters grows the box
    // (10px/char wide, 1.5× fontSize tall — deliberately wider/taller than a
    // Chromium-measured rect, mimicking fallback-font metric drift).
    let chars = '';
    Object.defineProperty(node, 'characters', {
      get: () => chars,
      set: (v: string) => {
        chars = String(v);
        const figma = (globalThis as any).figma;
        const sim = figma?.__autoSizeTexts;
        if (sim) {
          // true → growth simulation; {width,height} → exact size simulation.
          node.width = typeof sim === 'object' ? sim.width : Math.max(1, chars.length * 10);
          node.height = typeof sim === 'object' ? sim.height : Math.round((node.fontSize || 16) * 1.5);
        }
      },
    });
  }
  return node;
}

beforeAll(async () => {
  const failFonts = new Set<string>();
  const hangFonts = new Set<string>();
  const fontLoadCounts = new Map<string, number>();
  let createImageCalls = 0;
  const findDeep = (nodes: any[], fn: (n: any) => boolean): any => {
    for (const n of nodes) {
      if (fn(n)) return n;
      const hit = findDeep(n.children ?? [], fn);
      if (hit) return hit;
    }
    return null;
  };
  const figmaStub: any = {
    root: { name: 'UnitTestFile' },
    editorType: 'figma',
    __failFonts: failFonts,
    __hangFonts: hangFonts,
    __fontLoadCount: (key: string) => fontLoadCounts.get(key) ?? 0,
    __createImageCalls: () => createImageCalls,
    currentPage: {
      id: '0:1',
      name: 'Page 1',
      selection: [],
      children: [] as any[],
      appendChild(child: any) {
        this.children.push(child);
      },
      findOne(fn: (n: any) => boolean) {
        return findDeep(this.children, fn);
      },
    },
    showUI: () => {},
    notify: () => {},
    ui: {
      set onmessage(fn: (msg: any) => Promise<void>) {
        onMessage = fn;
      },
      postMessage: (msg: PostedMessage) => {
        posted.push(msg);
      },
    },
    createFrame: () => makeNode('FRAME'),
    createRectangle: () => makeNode('RECTANGLE'),
    createText: () => makeNode('TEXT'),
    createImage: () => {
      createImageCalls++;
      return { hash: 'hash-abc123' };
    },
    base64Decode: (s: string) => Uint8Array.from(Buffer.from(s, 'base64')),
    base64Encode: (b: Uint8Array) => Buffer.from(b).toString('base64'),
    loadFontAsync: async (font: { family: string; style: string }) => {
      const key = `${font.family} ${font.style}`;
      fontLoadCounts.set(key, (fontLoadCounts.get(key) ?? 0) + 1);
      if (hangFonts.has(key)) return new Promise(() => {}); // never settles — the observed Figma hang
      if (failFonts.has(key)) throw new Error(`missing font ${key}`);
    },
  };
  (globalThis as any).figma = figmaStub;
  (globalThis as any).__html__ = '<html></html>';
  // Indirect specifier: keeps tsc from pulling plugin/code.ts (a classic
  // script typechecked by its own plugin/tsconfig) into the root program,
  // while vite still resolves it at test runtime.
  const pluginEntry = '../../plugin/code';
  await import(pluginEntry);
});

function runCommand(id: string, command: string, params: any) {
  posted.length = 0;
  return onMessage!({ type: 'command', id, command, params }).then(() => [...posted]);
}

describe('plugin code.ts (sandbox half, stubbed figma)', () => {
  it('create_rectangle applies rotation as degrees → radians', async () => {
    const msgs = await runCommand('r1', 'create_rectangle', { width: 10, height: 4, rotation: 90 });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    const rect = (globalThis as any).figma.currentPage.children.at(-1);
    expect(rect.rotation).toBeCloseTo(Math.PI / 2, 6);
  });

  it('create_frame applies rotation as degrees → radians (negative ok)', async () => {
    const msgs = await runCommand('r2', 'create_frame', { width: 10, height: 10, rotation: -45 });
    expect(msgs.find((m) => m.type === 'command-result')?.ok).toBe(true);
    const frame = (globalThis as any).figma.currentPage.children.at(-1);
    expect(frame.rotation).toBeCloseTo(-Math.PI / 4, 6);
  });

  it('rotation omitted leaves node.rotation untouched', async () => {
    await runCommand('r3', 'create_rectangle', { width: 5, height: 5 });
    const rect = (globalThis as any).figma.currentPage.children.at(-1);
    expect(rect.rotation).toBe(0);
  });

  it('batch emits one progress heartbeat per command plus a final result', async () => {
    const msgs = await runCommand('b1', 'batch', {
      commands: [
        { command: 'create_rectangle', params: { width: 8, height: 8 } },
        { command: 'create_frame', params: { width: 8, height: 8 } },
      ],
    });
    // Filter out index-less liveness beats (command start / font retries);
    // per-command heartbeats carry an index.
    const progress = msgs.filter((m) => m.type === 'command-progress' && m.index !== undefined);
    expect(progress).toHaveLength(2);
    expect(progress.map((p) => p.index)).toEqual([0, 1]);
    expect(progress.every((p) => p.id === 'b1' && p.total === 2 && p.ok)).toBe(true);
    const final = msgs.find((m) => m.type === 'command-result');
    expect(final?.ok).toBe(true);
    expect(final?.result.aborted).toBe(false);
    expect(final?.result.results).toHaveLength(2);
    expect(final?.result.results[0]).toMatchObject({ index: 0, command: 'create_rectangle', ok: true });
  });

  it('batch aborts on error but still returns per-command partial results', async () => {
    const msgs = await runCommand('b2', 'batch', {
      commands: [
        { command: 'create_rectangle', params: { width: 8, height: 8 } },
        { command: 'delete_node', params: { nodeId: 'no:such' } }, // fails: not found
        { command: 'create_rectangle', params: { width: 9, height: 9 } }, // never runs
      ],
    });
    const final = msgs.find((m) => m.type === 'command-result');
    // No thrown envelope error — the caller always gets the results array.
    expect(final?.ok).toBe(true);
    expect(final?.result.aborted).toBe(true);
    expect(final?.result.error).toMatch(/node not found/);
    expect(final?.result.results).toHaveLength(2);
    expect(final?.result.results[0]).toMatchObject({ index: 0, ok: true });
    expect(final?.result.results[1]).toMatchObject({ index: 1, command: 'delete_node', ok: false });
    // The failed command also heartbeats, so the server knows how far it got.
    // (Index-less liveness beats are filtered out.)
    const progress = msgs.filter((m) => m.type === 'command-progress' && m.index !== undefined);
    expect(progress.map((p) => [p.index, p.ok])).toEqual([
      [0, true],
      [1, false],
    ]);
  });

  it('batch with stopOnError:false continues past failures', async () => {
    const msgs = await runCommand('b3', 'batch', {
      stopOnError: false,
      commands: [
        { command: 'delete_node', params: { nodeId: 'no:such' } },
        { command: 'create_rectangle', params: { width: 8, height: 8 } },
      ],
    });
    const final = msgs.find((m) => m.type === 'command-result');
    expect(final?.result.aborted).toBe(false);
    expect(final?.result.results).toHaveLength(2);
    expect(final?.result.results[0].ok).toBe(false);
    expect(final?.result.results[1].ok).toBe(true);
  });

  it('batch rejects nested batch and unknown commands as per-command failures', async () => {
    const msgs = await runCommand('b4', 'batch', {
      commands: [{ command: 'batch', params: { commands: [] } }, { command: 'nope_command' }],
      stopOnError: false,
    });
    const final = msgs.find((m) => m.type === 'command-result');
    expect(final?.result.results[0].error).toMatch(/nested batch/);
    expect(final?.result.results[1].error).toMatch(/unknown command/);
  });
});

describe('plugin code.ts — importer fix support', () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('create_frame applies strokes + four-corner cornerRadius', async () => {
    const msgs = await runCommand('s1', 'create_frame', {
      width: 40,
      height: 40,
      cornerRadius: [36, 36, 0, 0],
      strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
      strokeWeight: 2,
    });
    expect(msgs.find((m) => m.type === 'command-result')?.ok).toBe(true);
    const frame = (globalThis as any).figma.currentPage.children.at(-1);
    expect(frame.topLeftRadius).toBe(36);
    expect(frame.bottomRightRadius).toBe(0);
    expect(frame.strokeWeight).toBe(2);
    expect(frame.strokes).toHaveLength(1);
  });

  it('insert_image applies cornerRadius (native image rounding)', async () => {
    const msgs = await runCommand('i1', 'insert_image', {
      bytesBase64: PNG_1PX,
      width: 100,
      height: 100,
      cornerRadius: 30,
    });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    expect(result?.result.imageHash).toBe('hash-abc123');
    const rect = (globalThis as any).figma.currentPage.children.at(-1);
    expect(rect.cornerRadius).toBe(30);
    expect(rect.fills[0]).toMatchObject({ type: 'IMAGE', imageHash: 'hash-abc123' });
  });

  it('insert_image rejects SVG payloads with an explicit error', async () => {
    const svgB64 = Buffer.from('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', 'utf8').toString('base64');
    const msgs = await runCommand('i2', 'insert_image', { bytesBase64: svgB64, width: 10, height: 10 });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/SVG payloads are not supported/);
  });

  it('create_text falls back through fallbackStyles and reports fontApplied + fontFallback', async () => {
    const figma = (globalThis as any).figma;
    figma.__failFonts.add('Inter SemiBold');
    const msgs = await runCommand('t1', 'create_text', {
      characters: 'Hello',
      fontName: { family: 'Inter', style: 'SemiBold' },
      fallbackStyles: ['Medium', 'Bold', 'Regular'],
    });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    expect(result?.result.fontApplied).toEqual({ family: 'Inter', style: 'Medium' });
    expect(result?.result.fontFallback).toMatch(/Inter SemiBold unavailable/);
    const text = figma.currentPage.children.at(-1);
    expect(text.fontName).toEqual({ family: 'Inter', style: 'Medium' });
    figma.__failFonts.delete('Inter SemiBold');
  });

  it('set_fills warns when the write does not stick', async () => {
    const figma = (globalThis as any).figma;
    // A node whose fills setter silently ignores writes (the observed bridge quirk).
    const stubborn: any = makeNode('FRAME');
    let stored: any = [];
    Object.defineProperty(stubborn, 'fills', {
      get: () => stored,
      set: () => {
        /* ignored — quirk simulation */
      },
    });
    figma.currentPage.appendChild(stubborn);
    const msgs = await runCommand('f1', 'set_fills', {
      nodeId: stubborn.id,
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    expect(result?.result.warning).toMatch(/did not stick/);

    // And the normal path returns no warning.
    const normal: any = makeNode('FRAME');
    normal.fills = []; // real geometry nodes always expose fills
    figma.currentPage.appendChild(normal);
    const msgs2 = await runCommand('f2', 'set_fills', {
      nodeId: normal.id,
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    });
    const result2 = msgs2.find((m) => m.type === 'command-result');
    expect(result2?.ok).toBe(true);
    expect(result2?.result.warning).toBeUndefined();
  });
});

describe('plugin code.ts — textAutoResize (P1)', () => {
  it('create_text applies WIDTH_AND_HEIGHT and skips the fixed resize', async () => {
    const figma = (globalThis as any).figma;
    const msgs = await runCommand('ar1', 'create_text', {
      characters: 'Midnight Drive',
      fontName: { family: 'Inter', style: 'Bold' },
      width: 378,
      height: 60,
      textAutoResize: 'WIDTH_AND_HEIGHT',
    });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    const text = figma.currentPage.children.at(-1);
    expect(text.textAutoResize).toBe('WIDTH_AND_HEIGHT');
    expect(text.width).toBe(0); // no fixed resize ran
  });

  it('create_text HEIGHT keeps the fixed width, NONE keeps the fixed box', async () => {
    const figma = (globalThis as any).figma;
    await runCommand('ar2', 'create_text', {
      characters: 'paragraph',
      fontName: { family: 'Inter', style: 'Regular' },
      width: 300,
      height: 200,
      textAutoResize: 'HEIGHT',
    });
    const para = figma.currentPage.children.at(-1);
    expect(para.textAutoResize).toBe('HEIGHT');
    expect(para.width).toBe(300);
    await runCommand('ar3', 'create_text', {
      characters: 'legacy',
      fontName: { family: 'Inter', style: 'Regular' },
      width: 100,
      height: 50,
      textAutoResize: 'NONE',
    });
    const legacy = figma.currentPage.children.at(-1);
    expect(legacy.textAutoResize).toBe('NONE');
    expect(legacy.width).toBe(100);
    expect(legacy.height).toBe(50);
  });

  it('create_text without textAutoResize keeps the legacy fixed-box behavior', async () => {
    const figma = (globalThis as any).figma;
    await runCommand('ar4', 'create_text', {
      characters: 'old spec',
      fontName: { family: 'Inter', style: 'Regular' },
      width: 120,
      height: 40,
    });
    const text = figma.currentPage.children.at(-1);
    expect(text.textAutoResize).toBe('NONE');
    expect(text.width).toBe(120);
  });
});

describe('plugin code.ts — loadFontAsync hang resilience', () => {
  it('create_text times out a hanging loadFontAsync and falls back instead of freezing', async () => {
    const figma = (globalThis as any).figma;
    figma.__hangFonts.add('PingFang SC ExtraBold');
    vi.useFakeTimers();
    try {
      posted.length = 0;
      const p = onMessage!({
        type: 'command',
        id: 'hf1',
        command: 'create_text',
        params: {
          characters: '标题',
          fontName: { family: 'PingFang SC', style: 'ExtraBold' },
          fallbackStyles: ['SemiBold', 'Medium'],
        },
      });
      await vi.advanceTimersByTimeAsync(9000); // requested-font load times out at 8s
      await p;
      const result = posted.find((m) => m.type === 'command-result');
      expect(result?.ok).toBe(true);
      expect(result?.result.fontApplied).toEqual({ family: 'PingFang SC', style: 'SemiBold' });
      expect(result?.result.fontFallback).toMatch(/PingFang SC ExtraBold unavailable/);
    } finally {
      vi.useRealTimers();
      figma.__hangFonts.delete('PingFang SC ExtraBold');
    }
  });

  it('batch emits start-of-command liveness beats and survives a hanging font mid-batch', async () => {
    const figma = (globalThis as any).figma;
    figma.__hangFonts.add('PingFang SC ExtraBold');
    vi.useFakeTimers();
    try {
      posted.length = 0;
      const p = onMessage!({
        type: 'command',
        id: 'hf2',
        command: 'batch',
        params: {
          commands: [
            { command: 'create_rectangle', params: { width: 4, height: 4 } },
            { command: 'create_text', params: { characters: 'x', fontName: { family: 'PingFang SC', style: 'ExtraBold' } } },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(9000);
      await p;
      const final = posted.find((m) => m.type === 'command-result');
      expect(final?.ok).toBe(true);
      expect(final?.result.aborted).toBe(false);
      expect(final?.result.results).toHaveLength(2);
      // Fallback chain: family Regular succeeds → text still created.
      expect(final?.result.results[1].result.fontApplied).toEqual({ family: 'PingFang SC', style: 'Regular' });
      // Index-less beats: at least one per command start plus font attempts.
      const beats = posted.filter((m) => m.type === 'command-progress' && m.index === undefined);
      expect(beats.length).toBeGreaterThanOrEqual(2);
      // Per-command heartbeats still fire after each command finishes.
      const indexed = posted.filter((m) => m.type === 'command-progress' && m.index !== undefined);
      expect(indexed.map((m) => [m.index, m.ok])).toEqual([
        [0, true],
        [1, true],
      ]);
    } finally {
      vi.useRealTimers();
      figma.__hangFonts.delete('PingFang SC ExtraBold');
    }
  });
});

describe('plugin code.ts — optimization round', () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('font cache: a second create_text with the same font does not call loadFontAsync again', async () => {
    const figma = (globalThis as any).figma;
    const before = figma.__fontLoadCount('CacheFam Regular');
    await runCommand('fc1', 'create_text', { characters: 'a', fontName: { family: 'CacheFam', style: 'Regular' } });
    await runCommand('fc2', 'create_text', { characters: 'b', fontName: { family: 'CacheFam', style: 'Regular' } });
    expect(figma.__fontLoadCount('CacheFam Regular') - before).toBe(1);
  });

  it('weight-preserving fallback: a fully missing family lands on Inter at the requested weight', async () => {
    const figma = (globalThis as any).figma;
    figma.__failFonts.add('GhostFam Bold');
    figma.__failFonts.add('GhostFam SemiBold');
    figma.__failFonts.add('GhostFam Semi Bold'); // spaced spelling variant
    figma.__failFonts.add('GhostFam Regular');
    const msgs = await runCommand('wf1', 'create_text', {
      characters: 'heavy',
      fontName: { family: 'GhostFam', style: 'Bold' },
      fallbackStyles: ['SemiBold'],
    });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    // Family Regular failed too → Inter Bold (weight preserved), not Inter Regular.
    expect(result?.result.fontApplied).toEqual({ family: 'Inter', style: 'Bold' });
    expect(result?.result.fontFallback).toMatch(/GhostFam Bold unavailable/);
  });

  it('styled runs: per-range fonts and fills applied through the load chain', async () => {
    const figma = (globalThis as any).figma;
    const msgs = await runCommand('sr1', 'create_text', {
      characters: 'Price $12 now',
      fontName: { family: 'RunsFam', style: 'Regular' },
      runs: [
        { start: 0, end: 6, fontName: { family: 'RunsFam', style: 'Regular' } },
        { start: 6, end: 9, fontName: { family: 'RunsFam', style: 'Bold' } },
        { start: 9, end: 13, fontName: { family: 'RunsFam', style: 'Regular' }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
      ],
    });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    expect(result?.result.warnings).toBeUndefined();
    const text = figma.currentPage.children.at(-1);
    expect(text.rangeFonts).toEqual([
      [0, 6, { family: 'RunsFam', style: 'Regular' }],
      [6, 9, { family: 'RunsFam', style: 'Bold' }],
      [9, 13, { family: 'RunsFam', style: 'Regular' }],
    ]);
    expect(text.rangeFills).toHaveLength(1);
    expect(text.rangeFills[0][0]).toBe(9);
  });

  it('a failing run keeps the base font and surfaces a warning; the node is still created', async () => {
    const figma = (globalThis as any).figma;
    figma.__failFonts.add('RunsFail Bold');
    figma.__failFonts.add('RunsFail Regular');
    // Inter Bold loads fine — the run degrades to Inter Bold rather than failing.
    const msgs = await runCommand('sr2', 'create_text', {
      characters: 'ab',
      fontName: { family: 'RunsBase', style: 'Regular' },
      runs: [{ start: 0, end: 1, fontName: { family: 'RunsFail', style: 'Bold' } }],
    });
    const result = msgs.find((m) => m.type === 'command-result');
    expect(result?.ok).toBe(true);
    const text = figma.currentPage.children.at(-1);
    // loadFont chain for the run fell back to Inter Bold — applied, with a warning.
    expect(text.rangeFonts[0][2]).toEqual({ family: 'Inter', style: 'Bold' });
    expect(result?.result.warnings?.some((w: string) => w.includes('RunsFail Bold unavailable'))).toBe(true);
  });

  it('insert_image imageHash reuse: duplicates skip bytes and createImage; unknown hash without bytes errors', async () => {
    const figma = (globalThis as any).figma;
    const before = figma.__createImageCalls();
    const first = await runCommand('hh1', 'insert_image', { imageHash: 'content-hash-1', bytesBase64: PNG_1PX, width: 10, height: 10 });
    expect(first.find((m) => m.type === 'command-result')?.ok).toBe(true);
    const second = await runCommand('hh2', 'insert_image', { imageHash: 'content-hash-1', width: 10, height: 10 });
    const res2 = second.find((m) => m.type === 'command-result');
    expect(res2?.ok).toBe(true);
    expect(res2?.result.imageHash).toBe('hash-abc123');
    expect(figma.__createImageCalls() - before).toBe(1); // decoded/created once
    const rect = figma.currentPage.children.at(-1);
    expect(rect.fills[0]).toMatchObject({ type: 'IMAGE', imageHash: 'hash-abc123' });
    const third = await runCommand('hh3', 'insert_image', { imageHash: 'never-seen', width: 10, height: 10 });
    expect(third.find((m) => m.type === 'command-result')?.ok).toBe(false);
    expect(third.find((m) => m.type === 'command-result')?.error).toMatch(/unknown imageHash/);
  });

  it('batch font preload: unique fonts load once up front, commands reuse the cache', async () => {
    const figma = (globalThis as any).figma;
    const before = figma.__fontLoadCount('PreFam Bold');
    const msgs = await runCommand('pl1', 'batch', {
      commands: [
        { command: 'create_text', params: { characters: 'x', fontName: { family: 'PreFam', style: 'Bold' } } },
        { command: 'create_text', params: { characters: 'y', fontName: { family: 'PreFam', style: 'Bold' } } },
        { command: 'create_rectangle', params: { width: 4, height: 4 } },
      ],
    });
    const final = msgs.find((m) => m.type === 'command-result');
    expect(final?.result.results.every((r: any) => r.ok)).toBe(true);
    expect(figma.__fontLoadCount('PreFam Bold') - before).toBe(1); // preloaded once, then cached
  });
});

describe('plugin code.ts — post-layout text re-anchoring (WIDTH_AND_HEIGHT)', () => {
  const figma = () => (globalThis as any).figma;

  it('anchorRight shifts x left so the original right edge survives content growth', async () => {
    figma().__autoSizeTexts = true;
    try {
      const msgs = await runCommand('ra1', 'create_text', {
        characters: '$1,615',
        fontName: { family: 'Inter', style: 'Regular' },
        x: 329,
        y: 10,
        width: 44,
        height: 22,
        textAutoResize: 'WIDTH_AND_HEIGHT',
        anchorRight: true,
      });
      expect(msgs.find((m) => m.type === 'command-result')?.ok).toBe(true);
      const text = figma().currentPage.children.at(-1);
      expect(text.width).toBe(60); // 6 chars × 10px — grew like a fallback font
      expect(text.x).toBe(329 - (60 - 44)); // right edge pinned at 329+44
      // Vertical recenter: auto-sized box (16×1.5=24) centered on the 22px slot.
      expect(text.y).toBe(10 - (24 - 22) / 2);
    } finally {
      delete figma().__autoSizeTexts;
    }
  });

  it('without anchorRight, x stays; vertical recenter still applies', async () => {
    figma().__autoSizeTexts = true;
    try {
      await runCommand('ra2', 'create_text', {
        characters: 'Add',
        fontName: { family: 'Inter', style: 'Regular' },
        x: 24,
        y: 2,
        width: 26,
        height: 20,
        fontSize: 14,
        textAutoResize: 'WIDTH_AND_HEIGHT',
      });
      const text = figma().currentPage.children.at(-1);
      expect(text.width).toBe(30);
      expect(text.x).toBe(24); // left anchor untouched
      // fontSize set after characters in the handler → stub height used default 16 → 24
      expect(text.y).toBe(2 - (text.height - 20) / 2);
    } finally {
      delete figma().__autoSizeTexts;
    }
  });

  it('fixed-width modes (HEIGHT / NONE) are never re-anchored', async () => {
    figma().__autoSizeTexts = true;
    try {
      await runCommand('ra3', 'create_text', {
        characters: 'paragraph text',
        fontName: { family: 'Inter', style: 'Regular' },
        x: 5,
        y: 6,
        width: 200,
        height: 60,
        textAutoResize: 'HEIGHT',
        anchorRight: true,
      });
      const text = figma().currentPage.children.at(-1);
      expect(text.x).toBe(5);
      expect(text.y).toBe(6);
      expect(text.width).toBe(200); // HEIGHT keeps the fixed width
    } finally {
      delete figma().__autoSizeTexts;
    }
  });

  it('matching measured size is a no-op (no sub-pixel jitter)', async () => {
    figma().__autoSizeTexts = { width: 50, height: 22 };
    try {
      await runCommand('ra4', 'create_text', {
        characters: 'exact',
        fontName: { family: 'Inter', style: 'Regular' },
        x: 7,
        y: 8,
        width: 50,
        height: 22,
        textAutoResize: 'WIDTH_AND_HEIGHT',
        anchorRight: true,
      });
      const text = figma().currentPage.children.at(-1);
      expect(text.x).toBe(7);
      expect(text.y).toBe(8);
    } finally {
      delete figma().__autoSizeTexts;
    }
  });

  it('styled runs path: re-anchoring still applies after per-range fonts', async () => {
    figma().__autoSizeTexts = true;
    try {
      const msgs = await runCommand('ra5', 'create_text', {
        characters: 'NECTAR50',
        fontName: { family: 'Inter', style: 'Regular' },
        x: 28,
        y: 2,
        width: 68,
        height: 20,
        textAutoResize: 'WIDTH_AND_HEIGHT',
        anchorRight: true,
        runs: [
          { start: 0, end: 4, fontName: { family: 'Inter', style: 'Regular' } },
          { start: 4, end: 8, fontName: { family: 'Inter', style: 'Bold' } },
        ],
      });
      expect(msgs.find((m) => m.type === 'command-result')?.ok).toBe(true);
      const text = figma().currentPage.children.at(-1);
      expect(text.rangeFonts).toHaveLength(2);
      expect(text.width).toBe(80);
      expect(text.x).toBe(28 - (80 - 68)); // right edge pinned at 28+68
      expect(text.y).toBe(2 - (text.height - 20) / 2);
    } finally {
      delete figma().__autoSizeTexts;
    }
  });
});

describe('metric compensation (fallback-font width drift)', () => {
  it('single-line auto-sized text that outgrows the extracted width gets negative letter-spacing', async () => {
    const figma = (globalThis as any).figma;
    figma.__autoSizeTexts = true;
    try {
      const msgs = await runCommand('mc1', 'create_text', {
        characters: 'Your Cart',
        name: 'heading',
        x: 10, y: 10,
        width: 60, // extraction measured 60px; sim renders 9 chars * 10px = 90px
        height: 24,
        fontSize: 24,
        fontName: { family: 'Inter', style: 'Semi Bold' },
        textAutoResize: 'WIDTH_AND_HEIGHT',
      });
      const result = msgs.find((m) => m.type === 'command-result');
      expect(result?.ok).toBe(true);
      const node = (globalThis as any).figma.currentPage.children[0].children.find((c: any) => c.name === 'heading') ??
        (globalThis as any).figma.currentPage.children.find((c: any) => c.name === 'heading');
      expect(node.letterSpacing).toMatchObject({ unit: 'PIXELS' });
      expect(node.letterSpacing.value).toBeLessThan(0);
      // 30px overflow over 9 chars = 3.33/char, clamped to 8% of 24px = 1.92
      expect(node.letterSpacing.value).toBeCloseTo(-1.92, 1);
    } finally {
      figma.__autoSizeTexts = false;
    }
  });

  it('no compensation when rendered width already fits', async () => {
    const figma = (globalThis as any).figma;
    figma.__autoSizeTexts = true;
    try {
      await runCommand('mc2', 'create_text', {
        characters: 'Add',
        name: 'btn',
        width: 100, // wider than the 30px sim render
        height: 24,
        fontSize: 16,
        textAutoResize: 'WIDTH_AND_HEIGHT',
      });
      const node = (globalThis as any).figma.currentPage.children.find((c: any) => c.name === 'btn') ??
        (globalThis as any).figma.currentPage.children[0]?.children?.find((c: any) => c.name === 'btn');
      expect(node.letterSpacing === undefined || node.letterSpacing.value >= 0).toBe(true);
    } finally {
      figma.__autoSizeTexts = false;
    }
  });
});
