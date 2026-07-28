/**
 * figmingo companion plugin (sandbox half).
 *
 * Architecture (fixed): code.js runs in Figma's restricted sandbox where
 * `new WebSocket()` is unavailable. The WebSocket connection to the local
 * figmingo-mcp server (ws://127.0.0.1:39220) therefore lives in the UI
 * iframe (ui.html). This file:
 *   - shows the UI (small connection-status panel),
 *   - answers the UI's init request (fileName / editorType / sessionId),
 *   - receives command envelopes from the UI via figma.ui.onmessage,
 *   - executes them against the Plugin API (handlers below, unchanged),
 *   - posts results back to the UI, which relays them over the socket.
 */

const PROTOCOL = 1;
const PLUGIN_VERSION = '0.1.0';
const sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function log(...args: unknown[]) {
  console.log('[figmingo]', ...args);
}

// ---- helpers ----

type AnyNode = SceneNode & Record<string, any>;

function findNode(id: string | undefined): BaseNode {
  if (!id) throw new Error('node id required');
  const node = figma.currentPage.findOne((n) => n.id === id) ?? (figma.currentPage.id === id ? figma.currentPage : null);
  if (!node) throw new Error(`node not found on current page: ${id}`);
  return node;
}

function parentOf(params: any, vars: Map<string, string>): BaseNode & ChildrenMixin {
  let ref = params.parentId;
  if (typeof ref === 'string' && ref.startsWith('$')) ref = vars.get(ref.slice(1));
  if (!ref) return figma.currentPage as unknown as BaseNode & ChildrenMixin;
  const node = findNode(ref);
  if (!('children' in node)) throw new Error(`node ${ref} cannot have children`);
  return node as BaseNode & ChildrenMixin;
}

function substitute(value: any, vars: Map<string, string>): any {
  if (typeof value === 'string' && value.startsWith('$')) return vars.get(value.slice(1)) ?? value;
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
  }
  return value;
}

async function loadFont(fontName?: { family: string; style: string }) {
  const font = fontName ?? { family: 'Inter', style: 'Regular' };
  try {
    await figma.loadFontAsync(font);
    return font;
  } catch {
    const fallbacks = [
      { family: font.family, style: 'Regular' },
      { family: 'Inter', style: 'Regular' },
    ];
    for (const f of fallbacks) {
      try {
        await figma.loadFontAsync(f);
        return f;
      } catch {
        /* try next */
      }
    }
    throw new Error(`font unavailable: ${font.family} ${font.style}`);
  }
}

function applyFills(node: GeometryMixin, fills: any[]) {
  if (Array.isArray(fills)) node.fills = fills;
}

// ---- command handlers ----

const handlers: Record<string, (params: any, vars: Map<string, string>) => Promise<any>> = {
  async create_frame(params, vars) {
    const parent = parentOf(params, vars);
    const frame = figma.createFrame();
    frame.name = params.name ?? 'Frame';
    parent.appendChild(frame);
    frame.x = params.x ?? 0;
    frame.y = params.y ?? 0;
    frame.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
    if (params.clipsContent !== undefined) frame.clipsContent = !!params.clipsContent;
    if (params.fills) applyFills(frame, params.fills);
    if (params.autoLayout) await handlers.set_auto_layout({ nodeId: frame.id, ...params.autoLayout }, vars);
    return { nodeId: frame.id };
  },

  async create_text(params, vars) {
    const parent = parentOf(params, vars);
    const font = await loadFont(params.fontName);
    const text = figma.createText();
    parent.appendChild(text);
    text.fontName = font;
    text.characters = String(params.characters ?? '');
    text.name = params.name ?? text.characters.slice(0, 40);
    text.x = params.x ?? 0;
    text.y = params.y ?? 0;
    if (params.fontSize) text.fontSize = params.fontSize;
    if (params.letterSpacing) text.letterSpacing = params.letterSpacing;
    if (params.lineHeight) text.lineHeight = params.lineHeight;
    if (params.textCase) text.textCase = params.textCase;
    if (params.textAlignHorizontal) text.textAlignHorizontal = params.textAlignHorizontal;
    if (params.textAlignVertical) text.textAlignVertical = params.textAlignVertical;
    if (params.fills) applyFills(text, params.fills);
    if (params.width || params.height) {
      text.textAutoResize = 'NONE';
      text.resize(Math.max(1, params.width ?? text.width), Math.max(1, params.height ?? text.height));
    }
    return { nodeId: text.id, fontApplied: font };
  },

  async create_rectangle(params, vars) {
    const parent = parentOf(params, vars);
    const rect = figma.createRectangle();
    rect.name = params.name ?? 'Rectangle';
    parent.appendChild(rect);
    rect.x = params.x ?? 0;
    rect.y = params.y ?? 0;
    rect.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
    if (params.cornerRadius !== undefined) rect.cornerRadius = params.cornerRadius;
    if (params.fills) applyFills(rect, params.fills);
    return { nodeId: rect.id };
  },

  async set_fills(params) {
    const node = findNode(params.nodeId) as AnyNode;
    if (!('fills' in node)) throw new Error(`node ${params.nodeId} has no fills`);
    node.fills = params.fills ?? [];
    return { nodeId: node.id };
  },

  async set_auto_layout(params) {
    const node = findNode(params.nodeId) as FrameNode;
    if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') {
      throw new Error(`auto-layout requires a frame-like node, got ${node.type}`);
    }
    const mode = params.mode ?? params.layoutMode ?? 'HORIZONTAL';
    node.layoutMode = mode === 'NONE' ? 'NONE' : mode === 'VERTICAL' || mode === 'column' ? 'VERTICAL' : 'HORIZONTAL';
    if (node.layoutMode !== 'NONE') {
      if (params.itemSpacing !== undefined) node.itemSpacing = params.itemSpacing;
      if (params.counterAxisSpacing !== undefined && 'counterAxisSpacing' in node) (node as any).counterAxisSpacing = params.counterAxisSpacing;
      const p = params.padding;
      if (p !== undefined) {
        if (typeof p === 'number') {
          node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = p;
        } else {
          if (p.top !== undefined) node.paddingTop = p.top;
          if (p.right !== undefined) node.paddingRight = p.right;
          if (p.bottom !== undefined) node.paddingBottom = p.bottom;
          if (p.left !== undefined) node.paddingLeft = p.left;
        }
      }
      if (params.primaryAxisAlignItems) node.primaryAxisAlignItems = params.primaryAxisAlignItems;
      if (params.counterAxisAlignItems) node.counterAxisAlignItems = params.counterAxisAlignItems;
      if (params.layoutWrap && 'layoutWrap' in node) (node as any).layoutWrap = params.layoutWrap;
    }
    return { nodeId: node.id };
  },

  async insert_image(params, vars) {
    const parent = parentOf(params, vars);
    const bytes = figma.base64Decode(params.bytesBase64);
    const image = figma.createImage(bytes);
    const rect = figma.createRectangle();
    rect.name = params.name ?? 'Image';
    parent.appendChild(rect);
    rect.x = params.x ?? 0;
    rect.y = params.y ?? 0;
    rect.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
    rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: params.scaleMode ?? 'FILL' }];
    return { nodeId: rect.id, imageHash: image.hash };
  },

  async move_node(params) {
    const node = findNode(params.nodeId) as SceneNode;
    if (params.x !== undefined) node.x = params.x;
    if (params.y !== undefined) node.y = params.y;
    return { nodeId: node.id, x: node.x, y: node.y };
  },

  async resize_node(params) {
    const node = findNode(params.nodeId) as LayoutMixin;
    if (!('resize' in node)) throw new Error(`node ${params.nodeId} cannot be resized`);
    // Missing dimension keeps the node's current size instead of forcing 100.
    const w = params.width ?? (node as any).width ?? 100;
    const h = params.height ?? (node as any).height ?? 100;
    (node as any).resize(Math.max(1, w), Math.max(1, h));
    return { nodeId: (node as any).id };
  },

  async delete_node(params) {
    const node = findNode(params.nodeId) as SceneNode;
    node.remove();
    return { deleted: params.nodeId };
  },

  async get_selection() {
    return {
      selection: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type })),
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      file: figma.root.name,
    };
  },

  async export_node(params) {
    const node = findNode(params.nodeId) as SceneNode;
    const format = (params.format ?? 'PNG') as ExportSettings['format'];
    // SCALE constraint is only valid for raster formats; SVG/PDF reject it.
    const settings: ExportSettings =
      format === 'SVG' || format === 'PDF'
        ? ({ format } as ExportSettings)
        : ({ format, constraint: { type: 'SCALE', value: params.scale ?? 1 } } as ExportSettings);
    const bytes = await (node as any).exportAsync(settings);
    return { nodeId: node.id, format, base64: figma.base64Encode(bytes) };
  },

  async batch(params, vars) {
    const results: any[] = [];
    const stopOnError = params.stopOnError !== false;
    for (const cmd of params.commands ?? []) {
      const handler = handlers[cmd.command];
      if (!handler) {
        const err = { command: cmd.command, ok: false, error: `unknown command ${cmd.command}` };
        results.push(err);
        if (stopOnError) throw new Error(`batch aborted: unknown command ${cmd.command}`);
        continue;
      }
      try {
        const substituted = substitute(cmd.params ?? {}, vars);
        const result = await handler(substituted, vars);
        if (cmd.as && result?.nodeId) vars.set(cmd.as, result.nodeId);
        results.push({ command: cmd.command, ok: true, result });
      } catch (err) {
        results.push({ command: cmd.command, ok: false, error: err instanceof Error ? err.message : String(err) });
        if (stopOnError) throw err;
      }
    }
    return { executed: results.length, results };
  },
};

async function dispatch(command: string, params: any): Promise<any> {
  const handler = handlers[command];
  if (!handler) throw new Error(`unknown command: ${command}`);
  return handler(params, new Map());
}

// ---- UI bridge ----
// The WebSocket lives in ui.html (sandboxed code.js cannot open sockets).
// UI → code.js: ui-ready / bridge-state / command
// code.js → UI: init / command-result

figma.showUI(__html__, { width: 280, height: 120, title: 'figmingo' });

figma.ui.onmessage = async (msg: any) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ui-ready') {
    figma.ui.postMessage({
      type: 'init',
      protocol: PROTOCOL,
      sessionId,
      pluginVersion: PLUGIN_VERSION,
      fileName: figma.root.name,
      editorType: figma.editorType,
    });
    return;
  }

  if (msg.type === 'bridge-state') {
    if (msg.state === 'connected') figma.notify('figmingo: connected to local MCP server');
    if (msg.state === 'failed') figma.notify(`figmingo: bridge connection failed (${msg.error ?? 'unknown'})`, { error: true });
    return;
  }

  if (msg.type === 'command' && typeof msg.id === 'string' && typeof msg.command === 'string') {
    log('command', msg.command, msg.id);
    try {
      const result = await dispatch(msg.command, msg.params ?? {});
      figma.ui.postMessage({ type: 'command-result', id: msg.id, ok: true, result: result ?? null });
    } catch (err) {
      figma.ui.postMessage({
        type: 'command-result',
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
