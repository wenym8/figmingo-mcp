import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { renderScreenshot } from '../../replica/render';
import { comparePngBuffers, VISUAL_MAX_RATIO } from '../../replica/verify';
import type { ToolDef } from '../common';

export const compareHtmlToImage: ToolDef = {
  name: 'compare_html_to_image',
  description:
    'One-shot visual comparison: renders an HTML page/element with Playwright (chromium) and pixel-diffs it ' +
    'against a reference image (e.g. a Figma export). Returns pass/fail, diff ratio, anti-alias accounting, ' +
    'and per-band diff localization so you can see WHERE the mismatch lives. Replaces the manual ' +
    'render_html_screenshot → write-a-diff-script two-step.',
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
    imagePath: z.string().describe('Path to the reference image (PNG) to compare against.'),
    threshold: z.number().optional().default(0.1).describe('pixelmatch color-delta threshold (0-1).'),
    maxRatio: z.number().optional().default(VISUAL_MAX_RATIO).describe('Pass line for diffRatio.'),
    bands: z
      .number()
      .int()
      .optional()
      .default(10)
      .describe('Split the image vertically into N horizontal bands and report per-band diff ratios. 0 = off.'),
    outDiffPath: z.string().optional().describe('Where to save the diff PNG (red = mismatch). Temp file if omitted.'),
    keepRenderPath: z
      .string()
      .optional()
      .describe('Also save the rendered screenshot here and return its path. Discarded if omitted.'),
  },
  handler: async (_ctx, args) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-cmp-'));
    const renderPath = args.keepRenderPath ?? path.join(tmpDir, 'render.png');
    if (args.keepRenderPath) fs.mkdirSync(path.dirname(args.keepRenderPath), { recursive: true });
    const diffPath = args.outDiffPath ?? path.join(tmpDir, 'diff.png');
    if (args.outDiffPath) fs.mkdirSync(path.dirname(args.outDiffPath), { recursive: true });

    if (!fs.existsSync(args.imagePath)) {
      return { content: [{ type: 'text', text: JSON.stringify({ passed: false, error: `reference_not_found ${args.imagePath}` }, null, 2) }] };
    }
    await renderScreenshot({
      url: args.url,
      htmlPath: args.htmlPath,
      html: args.html,
      selector: args.selector,
      viewport: { width: args.viewportWidth, height: args.viewportHeight },
      fullPage: args.fullPage,
      hideFixed: args.hideFixed,
      waitForImages: args.waitForImages,
      settleMs: args.settleMs,
      outPath: renderPath,
    });
    const result = comparePngBuffers(fs.readFileSync(renderPath), fs.readFileSync(args.imagePath), {
      threshold: args.threshold,
      maxRatio: args.maxRatio,
      bands: args.bands,
      outPath: diffPath,
    });
    const payload: Record<string, unknown> = {
      passed: result.passed,
      diffRatio: result.diffRatio,
      diffPixels: result.diffPixels,
      totalPixels: result.totalPixels,
      antiAliasPixels: result.antiAliasPixels,
      size: result.size,
    };
    if (result.bands) payload.bands = result.bands;
    if (result.error) payload.error = result.error;
    if (!result.error && result.diffImagePath) payload.diffImagePath = result.diffImagePath;
    if (args.keepRenderPath) payload.renderPath = renderPath;
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    // Temp render/diff files stay in os.tmpdir() for the caller to inspect; the OS reclaims them.
  },
};
