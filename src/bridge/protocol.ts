/**
 * Command envelope protocol between the MCP server and the companion Figma
 * plugin over ws://127.0.0.1:39220.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

export interface BridgeHello {
  type: 'hello';
  protocol: number;
  sessionId: string;
  pluginVersion?: string;
  fileName?: string;
  editorType?: string;
}

export interface BridgeWelcome {
  type: 'welcome';
  protocol: number;
  serverVersion: string;
}

export interface BridgeCommand {
  type: 'command';
  id: string;
  command: string;
  params?: unknown;
}

export interface BridgeResult {
  type: 'result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Progress heartbeat. Batches send one per executed command so the server can
 * (a) reset its idle timer and (b) report exactly which command indexes are
 * confirmed applied on the canvas if the call later times out.
 */
export interface BridgeProgress {
  type: 'progress';
  id: string;
  /** 0-based index of the command that just finished (batch only). */
  index?: number;
  total?: number;
  command?: string;
  /** Whether that command succeeded. */
  ok?: boolean;
}

export interface BridgeError {
  type: 'error';
  message: string;
}

export type PluginToServer = BridgeHello | BridgeResult | BridgeProgress;
export type ServerToPlugin = BridgeWelcome | BridgeCommand | BridgeError;

/** Commands supported by execute_plugin_command / the plugin. */
export const PLUGIN_COMMANDS = [
  'create_frame',
  'create_text',
  'create_rectangle',
  'set_fills',
  'set_effects',
  'set_auto_layout',
  'insert_image',
  'move_node',
  'resize_node',
  'delete_node',
  'get_selection',
  'get_file_info',
  'get_page_children',
  'export_node',
] as const;

export type PluginCommandName = (typeof PLUGIN_COMMANDS)[number];

/**
 * Command parameter notes (the plugin accepts these loose JSON params):
 * - create_frame / create_rectangle: x, y, width, height, name, fills, effects,
 *   opacity, parentId (or "$var" batch ref), plus `rotation` (DEGREES,
 *   converted to radians for node.rotation), `cornerRadius` (uniform number or
 *   [topLeft, topRight, bottomRight, bottomLeft]), and stroke params
 *   (strokes, strokeWeight, strokeAlign, dashPattern). create_frame also takes
 *   clipsContent and autoLayout.
 * - create_text: fontName {family, style} plus optional `fallbackStyles`
 *   (same-family style names tried in order when the requested style fails to
 *   load); the result reports `fontApplied` and `fontFallback` so callers can
 *   surface degradations instead of silently landing on Regular.
 * - insert_image: bytesBase64 (raster only — SVG payloads are rejected with an
 *   explicit error), scaleMode, cornerRadius, stroke params, opacity.
 * - set_fills / set_effects: nodeId + payload; set_fills reads the fills back
 *   and returns a `warning` when Figma silently kept the previous value.
 * - export_node: nodeId, format (PNG|JPG|SVG|PDF), scale. Returns base64 by
 *   default; pass an absolute `outPath` to have the SERVER write the bytes to
 *   disk and return { path, bytes } instead of inline base64.
 */

/** Batch envelope: execute several commands sequentially inside the plugin. */
export interface BatchParams {
  commands: Array<{ command: PluginCommandName | string; params?: unknown }>;
  /** Stop on first error (default true). */
  stopOnError?: boolean;
}

export function isBridgeMessage(x: unknown): x is PluginToServer {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}
