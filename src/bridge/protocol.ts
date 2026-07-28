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

export interface BridgeError {
  type: 'error';
  message: string;
}

export type PluginToServer = BridgeHello | BridgeResult;
export type ServerToPlugin = BridgeWelcome | BridgeCommand | BridgeError;

/** Commands supported by execute_plugin_command / the plugin. */
export const PLUGIN_COMMANDS = [
  'create_frame',
  'create_text',
  'create_rectangle',
  'set_fills',
  'set_auto_layout',
  'insert_image',
  'move_node',
  'resize_node',
  'delete_node',
  'get_selection',
  'export_node',
] as const;

export type PluginCommandName = (typeof PLUGIN_COMMANDS)[number];

/** Batch envelope: execute several commands sequentially inside the plugin. */
export interface BatchParams {
  commands: Array<{ command: PluginCommandName | string; params?: unknown }>;
  /** Stop on first error (default true). */
  stopOnError?: boolean;
}

export function isBridgeMessage(x: unknown): x is PluginToServer {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}
