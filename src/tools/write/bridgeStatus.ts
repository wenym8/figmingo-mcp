import { z } from 'zod';
import { PLUGIN_COMMANDS } from '../../bridge/protocol';
import { textContent, type ToolDef } from '../common';

export const bridgeStatus: ToolDef = {
  name: 'bridge_status',
  description: 'Is the figmingo companion plugin connected? Reports client info, pending/queued command counts, and the bridge address.',
  schema: {},
  handler: async (ctx) => {
    const s = ctx.bridge.status();
    return textContent({
      ...s,
      supportedCommands: PLUGIN_COMMANDS,
      hint: s.connected
        ? undefined
        : 'Open Figma desktop → Plugins → Development → Import plugin from manifest… (plugin/manifest.json), ' +
          'then keep the figmingo plugin running. Commands sent while disconnected are queued (bounded) and flushed on connect.',
    });
  },
};
