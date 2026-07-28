import { z } from 'zod';
import { resolveTarget, targetSchema, type ToolDef, textContent } from '../common';

interface IndexEntry {
  kind: 'component' | 'component_set' | 'style' | 'variable';
  id: string; // node_id or style key
  nodeId?: string;
  key?: string;
  name: string;
  description?: string;
  type?: string;
}

function score(entry: IndexEntry, q: string): number {
  const name = entry.name.toLowerCase();
  const desc = (entry.description ?? '').toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 60;
  if (name.includes(q)) return 40;
  if (desc.includes(q)) return 15;
  // token overlap
  const tokens = q.split(/[\s/_-]+/).filter(Boolean);
  const hits = tokens.filter((t) => name.includes(t)).length;
  return hits * 8;
}

/**
 * search_design_system: local index over the file's components, component sets
 * and styles; text query + type filter.
 */
export const searchDesignSystem: ToolDef = {
  name: 'search_design_system',
  description: 'Search the file\'s design system: components, component sets, and published styles. Local index, no extra API quota beyond one file fetch.',
  schema: {
    ...targetSchema,
    query: z.string().describe('Free-text query matched against names/descriptions.'),
    types: z.array(z.enum(['component', 'component_set', 'style', 'variable'])).optional().describe('Restrict result kinds.'),
    limit: z.number().int().min(1).max(100).optional().default(20),
  },
  handler: async (ctx, args) => {
    const client = ctx.getClient();
    const { fileKey } = resolveTarget(args);
    const file: any = await client.getFile(fileKey);
    const index: IndexEntry[] = [];
    for (const [nodeId, c] of Object.entries<any>(file.components ?? {})) {
      index.push({ kind: c.containing_frame?.pageName ? 'component' : 'component', id: nodeId, nodeId, key: c.key, name: c.name, description: c.description });
    }
    for (const [nodeId, c] of Object.entries<any>(file.componentSets ?? {})) {
      index.push({ kind: 'component_set', id: nodeId, nodeId, key: c.key, name: c.name, description: c.description });
    }
    for (const [key, s] of Object.entries<any>(file.styles ?? {})) {
      index.push({ kind: 'style', id: key, key, nodeId: s.node_id, name: s.name, description: s.description, type: s.style_type });
    }

    const q = String(args.query).toLowerCase();
    const wanted = new Set(args.types ?? ['component', 'component_set', 'style', 'variable']);
    const results = index
      .filter((e) => wanted.has(e.kind))
      .map((e) => ({ ...e, score: score(e, q) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit ?? 20);
    return textContent({ fileKey, query: args.query, indexSize: index.length, count: results.length, results });
  },
};
