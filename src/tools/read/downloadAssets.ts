import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveTarget, targetSchema, type ToolDef } from '../common';

const EXT: Record<string, string> = { png: 'png', jpg: 'jpg', svg: 'svg', pdf: 'pdf' };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const downloadAssets: ToolDef = {
  name: 'download_assets',
  description:
    'Batch-export nodes as files (up to N ids, chunked) plus raw image fills from GET /v1/files/:key/images. ' +
    'Saves everything into a directory and returns a manifest. Temp Figma URLs are downloaded immediately and cached.',
  schema: {
    ...targetSchema,
    nodeIds: z.array(z.string()).optional().describe('Node ids to export. Omit to only download image fills.'),
    format: z.enum(['png', 'jpg', 'svg', 'pdf']).optional().default('png'),
    scale: z.number().min(0.01).max(4).optional().default(2),
    includeImageFills: z.boolean().optional().default(true),
    outDir: z.string().optional().describe('Output directory (default ~/.figmingo/assets/<fileKey>).'),
    maxBytesPerFile: z.number().optional().describe('Skip files larger than this many bytes.'),
  },
  handler: async (ctx, args) => {
      const client = ctx.getClient();
      const { fileKey } = resolveTarget(args);
      const outDir = path.resolve(args.outDir ?? path.join(os.homedir(), '.figmingo', 'assets', fileKey));
      fs.mkdirSync(outDir, { recursive: true });
      const saved: Array<{ kind: string; id: string; file: string; bytes: number }> = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      const save = async (kind: string, id: string, url: string, fileName: string) => {
        const buf = await client.downloadBinary(url);
        if (args.maxBytesPerFile && buf.length > args.maxBytesPerFile) {
          skipped.push({ id, reason: `too large: ${buf.length} bytes` });
          return;
        }
        const file = path.join(outDir, fileName);
        fs.writeFileSync(file, buf);
        saved.push({ kind, id, file, bytes: buf.length });
      };

      const ids: string[] = (args.nodeIds ?? []).map((s: string) => s.replace(/-/g, ':'));
      for (const group of chunk(ids, 50)) {
        const res: any = await client.getImages(fileKey, group, { format: args.format, scale: args.scale });
        const images = res?.images ?? {};
        for (const id of group) {
          const url = images[id];
          if (!url) {
            skipped.push({ id, reason: res?.err ? String(res.err) : 'no URL returned' });
            continue;
          }
          await save('node', id, url, `node-${id.replace(/:/g, '-')}.${EXT[args.format]}`);
        }
      }

      if (args.includeImageFills !== false) {
        const res: any = await client.getImageFills(fileKey);
        const images = res?.meta?.images ?? {};
        for (const [hash, url] of Object.entries(images)) {
          if (typeof url !== 'string') continue;
          await save('image-fill', hash, url, `fill-${hash.slice(0, 16)}.png`);
        }
      }

      const manifest = { fileKey, outDir, saved, skipped, generatedAt: new Date().toISOString() };
      const manifestPath = path.join(outDir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      return { content: [{ type: 'text', text: JSON.stringify({ ...manifest, manifestPath }, null, 2) }] };
  },
};
