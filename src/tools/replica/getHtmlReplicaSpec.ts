import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { buildReplicaSpec, type ReplicaSpec } from '../../replica/spec';
import { resolveTarget, firstNodeDocument, targetSchema, type ToolDef, type ToolContext } from '../common';

export function defaultSpecPath(fileKey: string, nodeId?: string): string {
  const dir = path.join(os.homedir(), '.figmingo', 'replica');
  return path.join(dir, `${fileKey}${nodeId ? `-${nodeId.replace(/:/g, '-')}` : ''}.spec.json`);
}

export interface SpecBuildResult {
  spec: ReplicaSpec;
  specPath?: string;
}

/** Shared builder used by get_html_replica_spec and verify_html_parity. */
export async function buildSpecFromFigma(
  ctx: ToolContext,
  args: { fileKey: string; nodeId?: string; depth?: number; includeAssets?: boolean; downloadAssets?: boolean; logoPattern?: string; iconPattern?: string; sectionsMode?: 'auto' | 'self'; outPath?: string },
): Promise<SpecBuildResult> {
  const client = ctx.getClient();
  const { fileKey, nodeId } = args;

  let document: any;
  let fileName: string | undefined;
  let lastModified: string | undefined;
  if (nodeId) {
    const res: any = await client.getNodes(fileKey, [nodeId], { depth: args.depth });
    document = firstNodeDocument(res).document;
  } else {
    const res: any = await client.getFile(fileKey, { depth: args.depth });
    document = res.document;
    fileName = res.name;
    lastModified = res.lastModified;
  }

  let imageFills: Record<string, string> | undefined;
  if (args.includeAssets !== false) {
    try {
      const fillsRes: any = await client.getImageFills(fileKey);
      imageFills = fillsRes?.meta?.images ?? {};
    } catch {
      imageFills = undefined;
    }
  }

  const spec = buildReplicaSpec(document, {
    fileKey,
    fileName,
    lastModified,
    imageFills,
    logoPattern: args.logoPattern,
    iconPattern: args.iconPattern,
    sections: args.sectionsMode,
    includeAssets: args.includeAssets,
  });

  // Export vector/svg assets as real SVG URLs when possible.
  if (args.includeAssets !== false) {
    const svgAssets = spec.assets.filter((a) => a.kind === 'svg' && !a.url);
    if (svgAssets.length) {
      try {
        const ids = svgAssets.map((a) => a.nodeIds[0]);
        const imagesRes: any = await client.getImages(fileKey, ids, { format: 'svg' });
        for (const a of svgAssets) {
          const url = imagesRes?.images?.[a.nodeIds[0]];
          if (url) a.url = url;
        }
      } catch {
        /* svg export unavailable (e.g. mock) — leave urls empty */
      }
    }
  }

  // Optionally download image assets to a local directory and rewrite urls to file paths.
  if (args.downloadAssets) {
    const dir = path.join(os.homedir(), '.figmingo', 'replica', 'assets', fileKey);
    fs.mkdirSync(dir, { recursive: true });
    for (const a of spec.assets) {
      if (!a.url) continue;
      try {
        const buf = await client.downloadBinary(a.url);
        const file = path.join(dir, a.fileName);
        fs.writeFileSync(file, buf);
        (a as any).localPath = file;
      } catch {
        /* keep remote url */
      }
    }
  }

  let specPath: string | undefined;
  if (args.outPath) {
    specPath = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  }
  return { spec, specPath };
}

export const getHtmlReplicaSpec: ToolDef = {
  name: 'get_html_replica_spec',
  description:
    'Build a replica-optimized spec from a Figma file/node: sections/elements with absolute rects, computed ' +
    'typography (family/style/size/letter-spacing/line-height/text-case), hex+alpha colors, gradient data, and an ' +
    'asset manifest (icons→svg, image fills→urls, logo hints). Output schema matches verify_html_parity input.',
  schema: {
    ...targetSchema,
    depth: z.number().int().min(1).max(50).optional(),
    sectionsMode: z.enum(['auto', 'self']).optional().default('auto').describe('auto = child containers become sections; self = whole node is one section.'),
    includeAssets: z.boolean().optional().default(true),
    downloadAssets: z.boolean().optional().default(false).describe('Download asset bytes and add localPath to manifest entries.'),
    logoPattern: z.string().optional().describe('Regex for logo asset hints (default /logo/i on node names).'),
    iconPattern: z.string().optional().describe('Regex for icon asset hints on node names.'),
    outPath: z.string().optional().describe('Where to write the spec JSON (default ~/.figmingo/replica/<fileKey>-<node>.spec.json).'),
    inline: z.boolean().optional().default(false).describe('Return the full spec inline (can be large). Default: return summary + path.'),
  },
  handler: async (ctx, args) => {
    const { fileKey, nodeId } = resolveTarget(args);
    const outPath = args.outPath ?? defaultSpecPath(fileKey, nodeId);
    const { spec, specPath } = await buildSpecFromFigma(ctx, { ...args, fileKey, nodeId, outPath });
    const summary = {
      specPath,
      file: spec.file,
      node: spec.node,
      canvas: spec.canvas,
      sectionCount: spec.sections.length,
      elementCount: spec.sections.reduce((n, s) => n + s.elements.length, 0),
      assetCount: spec.assets.length,
      sections: spec.sections.map((s) => ({ id: s.id, name: s.name, rect: s.rect, elements: s.elements.length })),
    };
    const content: any[] = [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
    if (args.inline) content.push({ type: 'text', text: JSON.stringify(spec) });
    return { content };
  },
};
