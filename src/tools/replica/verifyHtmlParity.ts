import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ReplicaSpec } from '../../replica/spec';
import { extractHtmlSpec, type HtmlLayoutSpec } from '../../replica/render';
import {
  runContentGate,
  runStructuralGate,
  runVisualGate,
  summarizeReport,
  type VerifyOptions,
  POS_TOL,
  COLOR_TOL,
  FONT_SIZE_TOL,
  LS_TOL,
  LH_TOL,
  VISUAL_MAX_RATIO,
} from '../../replica/verify';
import type { ToolDef } from '../common';

function loadSpec(args: any): ReplicaSpec {
  if (args.spec) return typeof args.spec === 'string' ? JSON.parse(args.spec) : args.spec;
  const p = args.specPath ?? args.spec_path;
  if (!p) throw new Error('specPath or spec is required (use get_html_replica_spec to produce one)');
  return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
}

export const verifyHtmlParity: ToolDef = {
  name: 'verify_html_parity',
  description:
    'The acceptance gate. Compares rendered HTML against a Figma replica spec: content gate (copy/font/color ' +
    `tolerances: font size ±${FONT_SIZE_TOL}px, letter-spacing ±${LS_TOL}px, line-height ±${LH_TOL}px, color ±${Math.round(
      COLOR_TOL * 255,
    )}/255), structural gate (position/size ±${POS_TOL}px), visual gate (pixelmatch diff ratio ≤ ${VISUAL_MAX_RATIO * 100}%, ` +
    '2px crop tolerance). Emits a JSON report + diff images.',
  schema: {
    specPath: z.string().optional().describe('Path to a spec JSON from get_html_replica_spec.'),
    spec: z.union([z.string(), z.record(z.any())]).optional().describe('Inline spec JSON (string or object).'),
    url: z.string().optional().describe('Remote URL of the HTML page.'),
    htmlPath: z.string().optional().describe('Local HTML file path.'),
    html: z.string().optional().describe('Raw HTML string.'),
    sections: z.array(z.object({ id: z.string(), selector: z.string() })).optional().describe('HTML section selectors (default: auto-detect semantic elements).'),
    viewportWidth: z.number().int().optional().default(1440),
    viewportHeight: z.number().int().optional().default(900),
    hideFixed: z.boolean().optional().default(false),
    figmaScreenshotPath: z.string().optional().describe('Existing PNG of the Figma design (skips REST render).'),
    skipVisual: z.boolean().optional().default(false).describe('Run only content+structural gates.'),
    skipSections: z.array(z.string()).optional().describe('Spec section ids/names to skip (e.g. floating widgets).'),
    sectionMap: z.record(z.string()).optional().describe('spec section id → html section id overrides.'),
    positionTolerance: z.number().optional().describe(`default ${POS_TOL}`),
    visualMaxRatio: z.number().optional().describe(`default ${VISUAL_MAX_RATIO}`),
    expectedCounts: z
      .object({ logos: z.number().optional(), assets: z.number().optional(), minIcons: z.number().optional() })
      .optional(),
    looseRectHints: z.record(z.number()).optional().describe('Extra rect slack per assetHint, e.g. {"product": 20}.'),
    outDir: z.string().optional().describe('Directory for report.json + diff images (default ./figmingo-parity-out).'),
  },
  handler: async (ctx, args) => {
    const spec = loadSpec(args);
    const outDir = path.resolve(args.outDir ?? 'figmingo-parity-out');
    fs.mkdirSync(outDir, { recursive: true });

    const opts: VerifyOptions = {
      positionTolerance: args.positionTolerance,
      visualMaxRatio: args.visualMaxRatio,
      skipSections: args.skipSections,
      sectionMap: args.sectionMap,
      expectedCounts: args.expectedCounts,
      looseRectHints: args.looseRectHints,
    };

    // 1) Extract the HTML side.
    const html: HtmlLayoutSpec = await extractHtmlSpec({
      url: args.url,
      htmlPath: args.htmlPath,
      html: args.html,
      sections: args.sections,
      viewport: { width: args.viewportWidth, height: args.viewportHeight },
      hideFixed: args.hideFixed,
    });
    fs.writeFileSync(path.join(outDir, 'html-extract.json'), JSON.stringify(html, null, 2));

    // 2) Content + structural gates.
    const content = runContentGate(spec, html, opts);
    const structural = runStructuralGate(spec, html, opts);

    // 3) Visual gate (full-page screenshots).
    let visual: ReturnType<typeof runVisualGate> = { passed: true, skipped: true, comparisons: [] };
    if (!args.skipVisual) {
      const pairs: Array<{ name: string; expected: Buffer; actual: Buffer }> = [];
      let figmaBuf: Buffer | undefined;
      if (args.figmaScreenshotPath) {
        figmaBuf = fs.readFileSync(path.resolve(args.figmaScreenshotPath));
      } else if (ctx.config.token && spec.file?.key) {
        try {
          const res: any = await ctx.getClient().getImages(spec.file.key, [spec.node.id], { format: 'png', scale: 1 });
          const url = res?.images?.[spec.node.id];
          if (url) figmaBuf = await ctx.getClient().downloadBinary(url);
        } catch (err) {
          visual.comparisons.push({ name: 'full-page', passed: false, error: `figma render failed: ${(err as Error).message}` });
          visual.passed = false;
        }
      }
      if (figmaBuf) {
        const { renderScreenshot } = await import('../../replica/render');
        const htmlShot = path.join(outDir, 'html-full.png');
        await renderScreenshot({
          url: args.url,
          htmlPath: args.htmlPath,
          html: args.html,
          viewport: { width: spec.canvas.width || args.viewportWidth, height: args.viewportHeight },
          hideFixed: args.hideFixed,
          outPath: htmlShot,
        });
        fs.writeFileSync(path.join(outDir, 'figma-expected.png'), figmaBuf);
        pairs.push({ name: 'full-page', expected: figmaBuf, actual: fs.readFileSync(htmlShot) });
        const gate = runVisualGate(pairs, outDir, opts);
        visual = { ...gate, skipped: false };
      } else if (visual.passed) {
        visual = {
          passed: true,
          skipped: true,
          comparisons: [
            { name: 'full-page', passed: true, error: 'skipped: provide figmaScreenshotPath or a token + spec.file.key for the Figma render' },
          ],
        };
      }
    }

    const report = summarizeReport(spec, content, structural, visual, opts);
    const reportPath = path.join(outDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              passed: report.passed,
              gates: {
                content: content.passed,
                structural: structural.passed,
                visual: visual.skipped ? 'SKIPPED' : visual.passed,
              },
              matched: `${structural.matched}/${structural.total}`,
              reportPath,
              outDir,
              details: report,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
