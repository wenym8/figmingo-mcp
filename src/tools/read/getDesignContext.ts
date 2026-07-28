import { z } from 'zod';
import { simplifyNode, simplifiedToCompact } from '../../figma/simplify';
import { resolveTarget, firstNodeDocument, textContent, targetSchema, type ToolDef } from '../common';

export const getDesignContext: ToolDef = {
  name: 'get_design_context',
  description:
    'Get the simplified design context for a Figma file or node: layout (absolute bounds, auto-layout), ' +
    'fills/strokes/effects, and text styles. Use format=compact for a small token footprint.',
  schema: {
    ...targetSchema,
    depth: z.number().int().min(1).max(50).optional().describe('Max traversal depth (default: full subtree).'),
    format: z.enum(['json', 'compact']).optional().default('json').describe('json = structured tree; compact = indented text lines.'),
    geometry: z.boolean().optional().describe('Pass geometry=bounds to the REST API (vector vertices etc.).'),
  },
  handler: async (ctx, args) => {
    const client = ctx.getClient();
    const { fileKey, nodeId } = resolveTarget(args);
    let document: any;
    let fileMeta: Record<string, unknown> = {};
    if (nodeId) {
      const res: any = await client.getNodes(fileKey, [nodeId], { depth: args.depth, geometry: args.geometry });
      document = firstNodeDocument(res).document;
    } else {
      const res: any = await client.getFile(fileKey, { depth: args.depth, geometry: args.geometry });
      document = res.document;
      fileMeta = { name: res.name, lastModified: res.lastModified, version: res.version };
    }
    const simplified = simplifyNode(document, { depth: args.depth });
    if (args.format === 'compact') {
      return textContent(simplifiedToCompact(simplified));
    }
    return textContent({ file: { key: fileKey, ...fileMeta }, nodeId: nodeId ?? document.id, design: simplified });
  },
};
