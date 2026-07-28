import { z } from 'zod';
import { PLUGIN_COMMANDS } from '../../bridge/protocol';
import { textContent, type ToolDef } from '../common';

const commandEnum = z.enum([...PLUGIN_COMMANDS] as [string, ...string[]]);

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
    'disconnected are queued (bounded) unless queue=false.',
  schema: {
    command: commandEnum.optional().describe('Single command name.'),
    params: z.record(z.any()).optional().describe('Parameters for the single command.'),
    commands: z
      .array(z.object({ command: commandEnum, params: z.record(z.any()).optional() }))
      .optional()
      .describe('Batch of commands; executed sequentially inside the plugin.'),
    stopOnError: z.boolean().optional().default(true).describe('Batch: stop on first error.'),
    timeoutMs: z.number().int().optional().describe('Per-command timeout once sent (default 30000).'),
    queue: z.boolean().optional().default(true).describe('Queue while disconnected (default true); false = fail immediately.'),
  },
  handler: async (ctx, args) => {
    if (!args.command && !args.commands?.length) {
      throw new Error('command or commands is required');
    }
    const opts = { timeoutMs: args.timeoutMs, failIfDisconnected: args.queue === false };
    if (args.commands?.length) {
      const result = await ctx.bridge.execute(
        'batch',
        { commands: args.commands, stopOnError: args.stopOnError !== false },
        opts,
      );
      return textContent({ batch: true, count: args.commands.length, result });
    }
    const result = await ctx.bridge.execute(args.command, args.params ?? {}, opts);
    return textContent({ command: args.command, result });
  },
};
