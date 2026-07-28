import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { renderScreenshot } from '../../replica/render';
import type { ToolDef } from '../common';

export const renderHtmlScreenshot: ToolDef = {
  name: 'render_html_screenshot',
  description:
    'Playwright (chromium) screenshot of a local/remote HTML page or an element selector. Waits for images to ' +
    'load, can hide fixed/sticky elements, supports full-page or selector-local captures.',
  schema: {
    url: z.string().optional().describe('Remote URL to render.'),
    htmlPath: z.string().optional().describe('Path to a local HTML file.'),
    html: z.string().optional().describe('Raw HTML string to render.'),
    selector: z.string().optional().describe('CSS selector for a partial (element) screenshot.'),
    viewportWidth: z.number().int().optional().default(1440),
    viewportHeight: z.number().int().optional().default(900),
    fullPage: z.boolean().optional().default(true),
    hideFixed: z.boolean().optional().default(false).describe('Hide position:fixed/sticky elements before shooting.'),
    waitForImages: z.boolean().optional().default(true),
    settleMs: z.number().int().optional().default(300),
    outPath: z.string().describe('Where to save the PNG.'),
    inline: z.boolean().optional().default(false).describe('Also return the PNG inline as base64.'),
  },
  handler: async (_ctx, args) => {
    const result = await renderScreenshot({
      url: args.url,
      htmlPath: args.htmlPath,
      html: args.html,
      selector: args.selector,
      viewport: { width: args.viewportWidth, height: args.viewportHeight },
      fullPage: args.fullPage,
      hideFixed: args.hideFixed,
      waitForImages: args.waitForImages,
      settleMs: args.settleMs,
      outPath: args.outPath,
    });
    const stat = fs.statSync(result.path);
    const content: any[] = [
      { type: 'text', text: JSON.stringify({ path: result.path, bytes: stat.size, width: result.width, height: result.height }, null, 2) },
    ];
    if (args.inline) {
      content.push({ type: 'image', data: fs.readFileSync(result.path).toString('base64'), mimeType: 'image/png' });
    }
    return { content };
  },
};

export function resolveOutDir(p?: string): string {
  const dir = path.resolve(p ?? 'figmingo-parity-out');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
