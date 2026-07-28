import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveTarget, targetSchema, type ToolDef } from '../common';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

export const getScreenshot: ToolDef = {
  name: 'get_screenshot',
  description:
    'Render a Figma node to an image via GET /v1/images/:fileKey (scale 0.01–4, png|jpg|svg|pdf). ' +
    'Returns the image inline (base64) and/or saves it to disk.',
  schema: {
    ...targetSchema,
    nodeId: z.string().describe('Node id to render, "1:2" or "1-2" form (or via url node-id).'),
    scale: z.number().min(0.01).max(4).optional().default(2),
    format: z.enum(['png', 'jpg', 'svg', 'pdf']).optional().default('png'),
    savePath: z.string().optional().describe('Optional file path to save the render to.'),
    inline: z.boolean().optional().default(true).describe('Return the image inline as base64 (default true).'),
  },
  handler: async (ctx, args) => {
    const client = ctx.getClient();
    const { fileKey, nodeId } = resolveTarget(args);
    const res: any = await client.getImages(fileKey, [nodeId!], { format: args.format, scale: args.scale });
    const url = res?.images?.[nodeId!];
    if (!url) throw new Error(`no render URL returned for node ${nodeId} (err: ${res?.err ?? 'unknown'})`);
    const buf = await client.downloadBinary(url);
    let savedTo: string | undefined;
    if (args.savePath) {
      const p = path.resolve(args.savePath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      savedTo = p;
    }
    const content: any[] = [];
    if (args.inline !== false) {
      content.push({ type: 'image', data: buf.toString('base64'), mimeType: MIME[args.format ?? 'png'] });
    }
    content.push({
      type: 'text',
      text: JSON.stringify({ nodeId, format: args.format, scale: args.scale, bytes: buf.length, savedTo }, null, 2),
    });
    return { content };
  },
};
