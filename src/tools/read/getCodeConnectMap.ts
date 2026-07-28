import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { walkRaw } from '../../figma/simplify';
import { resolveTarget, firstNodeDocument, targetSchema, type ToolDef, textContent } from '../common';

interface CodeConnectEntry {
  figma: { fileKey?: string; nodeId?: string; componentName?: string };
  code: { path?: string; component?: string; import?: string; props?: Record<string, unknown> };
}

/**
 * get_code_connect_map: reads a user-maintained figmingo.components.json
 * (component → code mapping) and returns matches for a node subtree.
 */
export const getCodeConnectMap: ToolDef = {
  name: 'get_code_connect_map',
  description:
    'Read figmingo.components.json (local component→code mapping) and return the code targets for components ' +
    'found in the requested node subtree.',
  schema: {
    ...targetSchema,
    mapPath: z.string().optional().describe('Path to figmingo.components.json (default: ./figmingo.components.json).'),
  },
  handler: async (ctx, args) => {
    const mapPath = path.resolve(args.mapPath ?? 'figmingo.components.json');
    let entries: CodeConnectEntry[];
    try {
      const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      entries = Array.isArray(raw) ? raw : raw.components ?? [];
    } catch {
      throw new Error(`code-connect map not found or invalid at ${mapPath}. Create one like: ` +
        `[{"figma":{"componentName":"Button/Primary"},"code":{"path":"src/Button.tsx","component":"Button"}}]`);
    }

    const { fileKey, nodeId } = resolveTarget(args);
    const client = ctx.getClient();
    let document: any;
    if (nodeId) {
      const res: any = await client.getNodes(fileKey, [nodeId]);
      document = firstNodeDocument(res).document;
    } else {
      const res: any = await client.getFile(fileKey);
      document = res.document;
    }

    const matches: Array<{ node: { id: string; name: string; type: string }; mapping: CodeConnectEntry }> = [];
    walkRaw(document, (n) => {
      if (!['COMPONENT', 'INSTANCE', 'COMPONENT_SET'].includes(n.type)) return;
      for (const e of entries) {
        if (e.figma?.fileKey && e.figma.fileKey !== fileKey) continue;
        if (e.figma?.nodeId && e.figma.nodeId !== n.id) continue;
        if (e.figma?.componentName && e.figma.componentName !== n.name && !n.name?.startsWith(`${e.figma.componentName}`)) continue;
        if (!e.figma?.nodeId && !e.figma?.componentName) continue;
        matches.push({ node: { id: n.id, name: n.name, type: n.type }, mapping: e });
      }
    });
    return textContent({ fileKey, nodeId: nodeId ?? document.id, mapPath, count: matches.length, matches });
  },
};
