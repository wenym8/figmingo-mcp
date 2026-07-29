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
  if (typeof ref === 'string' && ref.startsWith('$')) {
    const resolved = vars.get(ref.slice(1));
    // Never silently fall back to the page for an unresolved $var — that writes
    // nodes to the wrong parent. Batch vars live only within one envelope.
    if (!resolved) {
      throw new Error(
        `unresolved batch variable "${ref}": variables captured with "as" only live within a single batch envelope; reference the node id directly or capture it in the same batch`,
      );
    }
    ref = resolved;
  }
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
    return out;
  }
  return value;
}

/**
 * figma.loadFontAsync is only guaranteed to reject for missing fonts — in
 * practice it can also HANG (never settle) for unavailable families such as
 * PingFang SC ExtraBold, especially in long-lived degraded plugin sessions.
 * A hang here used to freeze the whole batch: the awaited command never
 * returned, no heartbeat was posted, and the server idle-timed-out. Race
 * every attempt against a timeout so a hang degrades into the fallback
 * chain instead of freezing the batch.
 */
const FONT_LOAD_TIMEOUT_MS = 8000;

function tryLoadFont(font: { family: string; style: string }): Promise<void> {
  return Promise.race([
    figma.loadFontAsync(font),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`loadFontAsync timed out after ${FONT_LOAD_TIMEOUT_MS}ms`)), FONT_LOAD_TIMEOUT_MS),
    ),
  ]);
}

async function loadFont(fontName?: { family: string; style: string }, fallbackStyles?: string[], beat?: () => void) {
  const font = fontName ?? { family: 'Inter', style: 'Regular' };
  try {
    beat?.();
    await tryLoadFont(font);
    return { font, fallback: undefined as string | undefined };
  } catch {
    const attempts: Array<{ family: string; style: string }> = [];
    // Same-family nearest styles first (e.g. SemiBold → Medium/Bold/Regular),
    // then family Regular, then Inter Regular as the floor.
    for (const style of fallbackStyles ?? []) attempts.push({ family: font.family, style });
    attempts.push({ family: font.family, style: 'Regular' }, { family: 'Inter', style: 'Regular' });
    const seen = new Set<string>([`${font.family} ${font.style}`]);
    for (const f of attempts) {
      const key = `${f.family} ${f.style}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        beat?.();
        await tryLoadFont(f);
        return { font: f, fallback: `requested ${font.family} ${font.style} unavailable` };
      } catch {
        /* try next */
      }
    }
    throw new Error(`font unavailable: ${font.family} ${font.style}`);
  }
}

/** Uniform number or [topLeft, topRight, bottomRight, bottomLeft]. */
function applyCornerRadius(node: any, radius: unknown) {
  if (Array.isArray(radius)) {
    const [tl, tr, br, bl] = radius.map((v) => Math.max(0, Number(v) || 0));
    node.topLeftRadius = tl;
    node.topRightRadius = tr;
    node.bottomRightRadius = br;
    node.bottomLeftRadius = bl;
  } else if (typeof radius === 'number' && Number.isFinite(radius)) {
    node.cornerRadius = Math.max(0, radius);
  }
}

function applyStroke(node: any, params: any) {
  if (params.strokes !== undefined) node.strokes = params.strokes;
  if (params.strokeWeight !== undefined) node.strokeWeight = params.strokeWeight;
  if (params.strokeAlign !== undefined) node.strokeAlign = params.strokeAlign;
  if (params.dashPattern !== undefined) node.dashPattern = params.dashPattern;
}

function applyFills(node: GeometryMixin, fills: any[]) {
  if (Array.isArray(fills)) node.fills = fills;
}

/** Params use degrees (CSS-like); the Plugin API stores radians. */
function applyRotation(node: LayoutMixin, degrees: unknown) {
  if (typeof degrees === 'number' && Number.isFinite(degrees)) {
    node.rotation = (degrees * Math.PI) / 180;
  }
}

interface RunCtx {
  /** Report that one batch command finished (heartbeat for the server). */
  reportProgress?: (info: { index: number; total: number; command: string; ok: boolean }) => void;
  /**
   * Liveness-only heartbeat (no command/index semantics): resets the server
   * idle timer while a long command is still running (e.g. between font-load
   * retries). Heartbeats otherwise only fire AFTER a command finishes, so a
   * single slow command could otherwise trip the idle timeout while healthy.
   */
  beat?: () => void;
}

// ---- command handlers ----

const handlers: Record<string, (params: any, vars: Map<string, string>, ctx?: RunCtx) => Promise<any>> = {
  async create_frame(params, vars) {
    const parent = parentOf(params, vars);
    const frame = figma.createFrame();
    frame.name = params.name ?? 'Frame';
    parent.appendChild(frame);
    frame.x = params.x ?? 0;
    frame.y = params.y ?? 0;
    frame.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
    if (params.clipsContent !== undefined) frame.clipsContent = !!params.clipsContent;
    if (params.cornerRadius !== undefined) applyCornerRadius(frame, params.cornerRadius);
    if (params.opacity !== undefined) frame.opacity = params.opacity;
    if (params.effects) frame.effects = params.effects;
    if (params.fills) applyFills(frame, params.fills);
    applyStroke(frame, params);
    applyRotation(frame, params.rotation);
    if (params.autoLayout) await handlers.set_auto_layout({ nodeId: frame.id, ...params.autoLayout }, vars);
    return { nodeId: frame.id };
  },

  async create_text(params, vars, ctx) {
    const parent = parentOf(params, vars);
    const { font, fallback } = await loadFont(params.fontName, params.fallbackStyles, ctx?.beat);
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
    if (params.opacity !== undefined) text.opacity = params.opacity;
    if (params.fills) applyFills(text, params.fills);
    const autoResize = params.textAutoResize ?? (params.width || params.height ? 'NONE' : undefined);
    if (autoResize) text.textAutoResize = autoResize;
    if (params.width || params.height) {
      if (autoResize === 'HEIGHT') {
        // Fixed width; height follows content (paragraph text).
        text.resize(Math.max(1, params.width ?? text.width), text.height);
      } else if (autoResize !== 'WIDTH_AND_HEIGHT') {
        // NONE (legacy path): fixed box, may wrap/clip.
        text.textAutoResize = 'NONE';
        text.resize(Math.max(1, params.width ?? text.width), Math.max(1, params.height ?? text.height));
      }
      // WIDTH_AND_HEIGHT: Figma sizes the box from the content — a fixed
      // resize would fight auto-width (Chromium→Figma metric drift otherwise
      // wraps single-line text into two lines).
    }
    return { nodeId: text.id, fontApplied: font, ...(fallback ? { fontFallback: fallback } : {}) };
  },

  async create_rectangle(params, vars) {
    const parent = parentOf(params, vars);
    const rect = figma.createRectangle();
    rect.name = params.name ?? 'Rectangle';
    parent.appendChild(rect);
    rect.x = params.x ?? 0;
    rect.y = params.y ?? 0;
    rect.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
    if (params.cornerRadius !== undefined) applyCornerRadius(rect, params.cornerRadius);
    if (params.opacity !== undefined) rect.opacity = params.opacity;
    if (params.effects) rect.effects = params.effects;
    if (params.fills) applyFills(rect, params.fills);
    applyStroke(rect, params);
    applyRotation(rect, params.rotation);
    return { nodeId: rect.id };
  },

  async set_fills(params) {
    const node = findNode(params.nodeId) as AnyNode;
    if (!('fills' in node)) throw new Error(`node ${params.nodeId} has no fills`);
    const requested = params.fills ?? [];
    node.fills = requested;
    // Bridge quirk guard: some nodes (observed on certain top-level frames)
    // report ok but silently keep their previous fills. Read back and warn.
    // NOTE: Figma normalizes paints on assignment (adds visible/opacity/
    // blendMode, rounds channels), so raw JSON comparison false-positives.
    // Compare semantically: count + per-paint type/color/opacity.
    const norm = (paints: unknown): string => {
      if (!Array.isArray(paints)) return String(paints);
      return paints
        .map((p: any) => {
          if (!p || typeof p !== 'object') return String(p);
          const c = p.color
            ? [p.color.r, p.color.g, p.color.b].map((v: number) => (typeof v === 'number' ? v.toFixed(3) : v)).join(',')
            : '';
          return `${p.type}:${c}:${p.opacity ?? 1}:${p.visible ?? true}`;
        })
        .join('|');
    };
    let warning: string | undefined;
    try {
      if (norm(node.fills) !== norm(requested)) {
        warning = `set_fills did not stick on ${node.id} (${node.type}): Figma kept the previous fills`;
      }
    } catch {
      /* fills not serializable (mixed values) — skip verification */
    }
    return { nodeId: node.id, ...(warning ? { warning } : {}) };
  },

  async set_effects(params) {
    const node = findNode(params.nodeId) as AnyNode;
    if (!('effects' in node)) throw new Error(`node ${params.nodeId} has no effects`);
    // Figma Effect[] e.g. [{type:'DROP_SHADOW', color:{r,g,b,a}, offset:{x,y}, radius, spread, visible:true, blendMode:'NORMAL'}]
    node.effects = params.effects ?? [];
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
      // Sizing modes: SPACE_BETWEEN needs primaryAxisSizingMode FIXED (the
      // default hug makes it a no-op); HUG/FILL for counter axis.
      if (params.primaryAxisSizingMode) (node as any).primaryAxisSizingMode = params.primaryAxisSizingMode;
      if (params.counterAxisSizingMode) (node as any).counterAxisSizingMode = params.counterAxisSizingMode;
      if (params.layoutWrap && 'layoutWrap' in node) (node as any).layoutWrap = params.layoutWrap;
      if (params.layoutGrow !== undefined) (node as any).layoutGrow = params.layoutGrow;
    }
    return { nodeId: node.id };
  },

  async insert_image(params, vars) {
    const parent = parentOf(params, vars);
    const bytes = figma.base64Decode(params.bytesBase64);
    // figma.createImage only accepts raster bytes (PNG/JPG/GIF/WebP). SVG
    // payloads decode "successfully" but render as grey boxes — reject early.
    let head = '';
    const sniff = Math.min(bytes.length, 256);
    for (let i = 0; i < sniff; i++) head += String.fromCharCode(bytes[i]);
    if (/^\s*</.test(head) && /<svg[\s>]/i.test(head)) {
      throw new Error('insert_image: SVG payloads are not supported by figma.createImage (rasterize the SVG to PNG first)');
    }
    const image = figma.createImage(bytes);
    const rect = figma.createRectangle();
    rect.name = params.name ?? 'Image';
    parent.appendChild(rect);
    rect.x = params.x ?? 0;
    rect.y = params.y ?? 0;
    rect.resize(Math.max(1, params.width ?? 100), Math.max(1, params.height ?? 100));
    if (params.cornerRadius !== undefined) applyCornerRadius(rect, params.cornerRadius);
    if (params.opacity !== undefined) rect.opacity = params.opacity;
    applyStroke(rect, params);
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

  async get_file_info() {
    return {
      // figma.fileKey is undefined only for never-saved local files.
      fileKey: (figma as any).fileKey ?? null,
      fileName: figma.root.name,
      editorType: figma.editorType,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
    };
  },

  async get_page_children(params) {
    const parent = params?.nodeId ? findNode(params.nodeId) : figma.currentPage;
    if (!('children' in parent)) throw new Error(`node ${params?.nodeId} cannot have children`);
    return {
      parent: { id: (parent as any).id, name: (parent as any).name, type: (parent as any).type },
      children: (parent as any).children.map((n: any) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        childCount: 'children' in n ? n.children.length : 0,
      })),
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

  async batch(params, vars, ctx) {
    const results: any[] = [];
    const commands: any[] = params.commands ?? [];
    const total = commands.length;
    const stopOnError = params.stopOnError !== false;
    let aborted = false;
    let abortError: string | undefined;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      // Liveness heartbeat at command start: heartbeats otherwise only fire
      // after a command finishes, so a slow command would trip the server
      // idle timer even while perfectly healthy.
      ctx?.beat?.();
      const handler = cmd.command === 'batch' ? undefined : handlers[cmd.command];
      if (!handler) {
        const error = cmd.command === 'batch' ? 'nested batch is not supported' : `unknown command ${cmd.command}`;
        results.push({ index: i, command: cmd.command, ok: false, error });
        ctx?.reportProgress?.({ index: i, total, command: String(cmd.command), ok: false });
        if (stopOnError) {
          aborted = true;
          abortError = error;
          break;
        }
        continue;
      }
      try {
        const substituted = substitute(cmd.params ?? {}, vars);
        const result = await handler(substituted, vars, ctx);
        if (cmd.as && result?.nodeId) vars.set(cmd.as, result.nodeId);
        results.push({ index: i, command: cmd.command, ok: true, result });
        ctx?.reportProgress?.({ index: i, total, command: String(cmd.command), ok: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ index: i, command: cmd.command, ok: false, error });
        // Heartbeat even for the failed command: the server learns exactly how
        // far the batch got before aborting.
        ctx?.reportProgress?.({ index: i, total, command: String(cmd.command), ok: false });
        if (stopOnError) {
          aborted = true;
          abortError = error;
          break;
        }
      }
    }
    // Always return the per-command results array — even on abort the caller
    // can see exactly which commands ran (and which one failed) instead of
    // getting a bare exception with no canvas state.
    return { executed: results.length, total, aborted, ...(abortError ? { error: abortError } : {}), results };
  },
};

async function dispatch(command: string, params: any, ctx?: RunCtx): Promise<any> {
  const handler = handlers[command];
  if (!handler) throw new Error(`unknown command: ${command}`);
  return handler(params, new Map(), ctx);
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
      const ctx: RunCtx = {
        reportProgress: (info) => figma.ui.postMessage({ type: 'command-progress', id: msg.id, ...info }),
        // Index-less progress message: the server treats any progress as a
        // liveness heartbeat and resets its idle timer without recording a
        // completed command index.
        beat: () => figma.ui.postMessage({ type: 'command-progress', id: msg.id }),
      };
      const result = await dispatch(msg.command, msg.params ?? {}, ctx);
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
