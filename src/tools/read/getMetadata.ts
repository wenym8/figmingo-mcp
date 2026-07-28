import { z } from 'zod';
import { metadataNode, metadataToXml } from '../../figma/simplify';
import { resolveTarget, firstNodeDocument, textContent, targetSchema, type ToolDef } from '../common';

export const getMetadata: ToolDef = {
  name: 'get_metadata',
  description:
    'Lightweight tree of a Figma file/node (id, name, type, bounds) for orientation before a deep fetch. ' +
    'Output as XML (default) or JSON.',
  schema: {
    ...targetSchema,
    depth: z.number().int().min(1).max(50).optional().describe('Max traversal depth (default: full subtree).'),
    format: z.enum(['xml', 'json']).optional().default('xml'),
  },
  handler: async (ctx, args) => {
    const client = ctx.getClient();
    const { fileKey, nodeId } = resolveTarget(args);
    let document: any;
    if (nodeId) {
      const res: any = await client.getNodes(fileKey, [nodeId], { depth: args.depth });
      document = firstNodeDocument(res).document;
    } else {
      const res: any = await client.getFile(fileKey, { depth: args.depth });
      document = res.document;
    }
    const meta = metadataNode(document, { depth: args.depth });
    if (args.format === 'json') return textContent(meta);
    return textContent(metadataToXml(meta));
  },
};
