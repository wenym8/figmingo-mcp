/**
 * Unit tests for the plugin sandbox half (plugin/code.ts) with a stubbed
 * `figma` global — no Figma desktop needed. Covers:
 *  - create_rectangle / create_frame `rotation` (degrees → radians)
 *  - batch per-command progress heartbeats + partial results on abort
 */
import { describe, it, expect, beforeAll } from 'vitest';

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
  };
  return node;
}

beforeAll(async () => {
  const figmaStub: any = {
    root: { name: 'UnitTestFile' },
    editorType: 'figma',
    currentPage: {
      id: '0:1',
      name: 'Page 1',
      selection: [],
      children: [] as any[],
      appendChild(child: any) {
        this.children.push(child);
      },
      findOne: () => null,
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
    loadFontAsync: async () => {},
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
    const progress = msgs.filter((m) => m.type === 'command-progress');
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
    const progress = msgs.filter((m) => m.type === 'command-progress');
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
