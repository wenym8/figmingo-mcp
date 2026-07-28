import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PLUGIN_COMMANDS } from '../../bridge/protocol';
import { textContent, type ToolDef } from '../common';

const commandEnum = z.enum([...PLUGIN_COMMANDS] as [string, ...string[]]);

/**
 * Persist an export_node base64 payload to disk (server side) and return the
 * result without the inline base64. The bytes already cross the bridge socket
 * as base64 today, so writing them here avoids a separate upload channel.
 */
export function persistExportBase64(result: any, outPath: string): any {
  if (!result || typeof result.base64 !== 'string') return result;
  const p = path.resolve(outPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = Buffer.from(result.base64, 'base64');
  fs.writeFileSync(p, buf);
  const { base64: _omit, ...rest } = result;
  return { ...rest, path: p, bytes: buf.length };
}

/** Rewrite batch results in place: any export_node entry whose command params carried outPath gets persisted. */
export function persistBatchExports(batchResult: any, commands: Array<{ command: string; params?: Record<string, any> }>): any {
  const results = batchResult?.results;
  if (!Array.isArray(results)) return batchResult;
  for (const entry of results) {
    if (!entry?.ok || !entry?.result) continue;
    const idx = typeof entry.index === 'number' ? entry.index : results.indexOf(entry);
    const outPath = commands[idx]?.params?.outPath;
    if (typeof outPath === 'string' && outPath) {
      entry.result = persistExportBase64(entry.result, outPath);
    }
  }
  return batchResult;
}

/**
 * execute_plugin_command: generic command envelope to the companion plugin.
 * Supports a single command or a batch (executed sequentially in the plugin).
 */
export const executePluginCommand: ToolDef = {
  name: 'execute_plugin_command',
  description:
    'Send a command envelope to the companion Figma plugin over the local bridge. Commands: ' +
    PLUGIN_COMMANDS.join(', ') +
    '. Use `commands` for a batch executed sequentially in the plugin. Commands sent while the plugin is ' +
    'disconnected are queued (bounded) unless queue=false. Batches emit per-command progress heartbeats: the call ' +
    'fails only after idleTimeoutMs of silence or the total timeoutMs cap, and timeout errors list the command ' +
    'indexes confirmed applied on the canvas. export_node accepts an absolute params.outPath to save bytes to ' +
    'disk and return { path, bytes } instead of inline base64.',
  schema: {
    command: commandEnum.optional().describe('Single command name.'),
    params: z.record(z.any()).optional().describe('Parameters for the single command.'),
    commands: z
      .array(
        z.object({
          command: commandEnum,
          params: z.record(z.any()).optional(),
          as: z.string().optional().describe('Capture result.nodeId into a batch variable; later commands can reference it as "$name" (e.g. parentId: "$frame").'),
        }),
      )
      .optional()
      .describe('Batch of commands; executed sequentially inside the plugin.'),
    stopOnError: z.boolean().optional().default(true).describe('Batch: stop on first error.'),
    timeoutMs: z
      .number()
      .int()
      .optional()
      .describe('Total cap in ms for the whole call once sent (default 300000 = 5 min). Batch heartbeats keep the call alive within this cap.'),
    idleTimeoutMs: z
      .number()
      .int()
      .optional()
      .describe('Max silence in ms with no progress/result before failing (default 20000). Reset by every batch progress heartbeat.'),
    queue: z.boolean().optional().default(true).describe('Queue while disconnected (default true); false = fail immediately.'),
  },
  handler: async (ctx, args) => {
    if (!args.command && !args.commands?.length) {
      throw new Error('command or commands is required');
    }
    const opts = { timeoutMs: args.timeoutMs, idleTimeoutMs: args.idleTimeoutMs, failIfDisconnected: args.queue === false };
    if (args.commands?.length) {
      const result = await ctx.bridge.execute(
        'batch',
        { commands: args.commands, stopOnError: args.stopOnError !== false },
        opts,
      );
      persistBatchExports(result, args.commands);
      return textContent({ batch: true, count: args.commands.length, result });
    }
    let result: any = await ctx.bridge.execute(args.command, args.params ?? {}, opts);
    if (args.command === 'export_node' && typeof args.params?.outPath === 'string' && args.params.outPath) {
      result = persistExportBase64(result, args.params.outPath);
    }
    return textContent({ command: args.command, result });
  },
};
