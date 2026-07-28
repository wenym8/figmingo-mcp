import { z } from 'zod';
import type { AppConfig } from '../config';
import { FigmaRestClient } from '../figma/client';
import type { PluginBridge } from '../bridge/server';
import { parseFigmaUrl, normalizeNodeId } from '../figma/urls';

export interface ToolContext {
  config: AppConfig;
  getClient: () => FigmaRestClient;
  bridge: PluginBridge;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (ctx: ToolContext, args: any) => Promise<unknown>;
}

export interface ResolvedTarget {
  fileKey: string;
  nodeId?: string;
}

export const targetSchema = {
  fileKey: z.string().optional().describe('Figma file key (from the file URL). Provide either fileKey or url.'),
  url: z.string().optional().describe('Full figma.com URL (design/file/proto). node-id query param is honored.'),
  nodeId: z.string().optional().describe('Node id, "1:2" or "1-2" form. Overrides node-id in url.'),
};

export function resolveTarget(args: { fileKey?: string; url?: string; nodeId?: string }): ResolvedTarget {
  let fileKey = args.fileKey;
  let nodeId = args.nodeId;
  if (args.url) {
    const parsed = parseFigmaUrl(args.url);
    fileKey = fileKey ?? parsed.fileKey;
    nodeId = nodeId ?? parsed.nodeId;
  }
  if (!fileKey) throw new Error('fileKey or url is required (could not parse a file key from the input)');
  return { fileKey, nodeId: nodeId ? normalizeNodeId(nodeId) : undefined };
}

/** Unwrap a /v1/files/:key/nodes response into the document of the first node. */
export function firstNodeDocument(nodesResponse: any): { nodeId: string; document: any; extra: any } {
  const nodes = nodesResponse?.nodes ?? {};
  const [nodeId, entry] = Object.entries(nodes)[0] as [string, any];
  if (!entry?.document) throw new Error(`node not found in file (check nodeId): ${nodeId}`);
  return { nodeId, document: entry.document, extra: entry };
}

export function textContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
