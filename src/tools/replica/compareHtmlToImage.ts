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
    'against a reference image (e.g. a Figma export). passed = diffRatio <= maxRatio (default 0.01 = 1%; ' +
    'raise maxRatio for rework/triage loops where you only need localization, not a strict gate). Returns ' +
    'diff ratio, anti-alias accounting (see methodology in the response), and per-band diff localization — ' +
    'equal-height bands or custom bandEdges so one band can map to one design element. Replaces the manual ' +
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
    initScript: z
      .string()
      .optional()
      .describe('JS run before page scripts (addInitScript) — passed through to the renderer, e.g. seed localStorage/state for multi-state replicas.'),
    imagePath: z.string().describe('Path to the reference image (PNG) to compare against.'),
    threshold: z
      .number()
      .optional()
      .default(0.1)
      .describe('pixelmatch color-delta threshold (0-1). Smaller = stricter per-pixel color comparison.'),
    maxRatio: z
      .number()
      .optional()
      .default(VISUAL_MAX_RATIO)
      .describe(
        'Pass line: passed = diffRatio <= maxRatio. Default 0.01 (1%). For rework rounds, raise it (e.g. 0.05) ' +
          'so the call still "passes" while you use bands/bandEdges to localize remaining diffs.',
      ),
    bands: z
      .number()
      .int()
      .optional()
      .default(10)
      .describe('Split the image vertically into N equal-height horizontal bands and report per-band diff ratios. 0 = off. Ignored when bandEdges is set.'),
    bandEdges: z
      .array(z.number())
      .optional()
      .describe(
        'Custom band boundaries, e.g. [0,120,280,974] → 3 bands [0,120) [120,280) [280,974). Lets one band map ' +
          'to one design element. Values are clamped to the image height, sorted, deduped. Mutually exclusive ' +
          'with bands — when both are given, bandEdges wins.',
      ),
    outDiffPath: z.string().optional().describe('Where to save the diff PNG (red = mismatch). Temp file if omitted.'),
    outRenderPath: z
      .string()
      .optional()
      .describe(
        'Also save the rendered screenshot to this path and return it as renderPath. Useful when you need the ' +
          'render PNG itself (e.g. measuring line widths) without a second render_html_screenshot call.',
      ),
    keepRenderPath: z
      .string()
      .optional()
      .describe('Deprecated alias of outRenderPath. If both are set, outRenderPath wins.'),
  },
  handler: async (_ctx, args) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-cmp-'));
    const persistRenderPath = args.outRenderPath ?? args.keepRenderPath;
    const renderPath = persistRenderPath ?? path.join(tmpDir, 'render.png');
    if (persistRenderPath) fs.mkdirSync(path.dirname(persistRenderPath), { recursive: true });
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
      initScript: args.initScript,
      outPath: renderPath,
    });
    const result = comparePngBuffers(fs.readFileSync(renderPath), fs.readFileSync(args.imagePath), {
      threshold: args.threshold,
      maxRatio: args.maxRatio,
      bands: args.bands,
      bandEdges: args.bandEdges,
      outPath: diffPath,
    });
    const payload: Record<string, unknown> = {
      passed: result.passed,
      diffRatio: result.diffRatio,
      diffPixels: result.diffPixels,
      totalPixels: result.totalPixels,
      antiAliasPixels: result.antiAliasPixels,
      size: result.size,
      methodology: {
        // Reflect the values actually used (zod defaults only apply when the
        // server parses args; direct handler calls may leave them undefined).
        threshold: args.threshold ?? 0.1,
        maxRatio: args.maxRatio ?? VISUAL_MAX_RATIO,
        // pixelmatch's primary count (includeAA: false) EXCLUDES pixels it flags as anti-aliased;
        // antiAliasPixels is derived from a second includeAA run and is NOT part of diffPixels/diffRatio.
        antiAliasCountedInDiff: false,
      },
    };
    if (result.bands) payload.bands = result.bands;
    if (result.error) payload.error = result.error;
    if (!result.error && result.diffImagePath) payload.diffImagePath = result.diffImagePath;
    if (persistRenderPath) payload.renderPath = renderPath;
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    // Temp render/diff files stay in os.tmpdir() for the caller to inspect; the OS reclaims them.
  },
};
