import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ReplicaAsset, ReplicaElement, ReplicaSpec, SpecStyle } from '../../replica/spec';
import {
  hexToRgb,
  parseCssColor,
  parseLinearGradient,
  linearGradientPaint,
  textCaseFromStyle,
  textAlignFromStyle,
  fontFromStyle,
  fontFallbackChain,
  parseBoxShadow,
  shadowEffects,
} from '../../replica/css';
import { extractHtmlToReplicaSpec } from '../../replica/extractHtmlSpec';
import { textContent, type ToolDef, type ToolContext } from '../common';

interface BridgeCmd {
  command: string;
  params?: Record<string, unknown>;
  as?: string;
}

export interface ImportStats {
  sections: number;
  texts: number;
  images: number;
  svgs: number;
  backgrounds: number;
  containers: number;
  placeholders: number;
  /** Commands confirmed ok by the plugin (only after execution). */
  created?: number;
}

export interface ImportPlan {
  commands: BridgeCmd[];
  stats: ImportStats;
  warnings: string[];
}

function solidFill(hex: string, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  return { type: 'SOLID', color: { r, g, b }, opacity: alpha };
}

function fillsFor(style: SpecStyle): unknown[] | undefined {
  if (style.backgroundImage && style.backgroundImage.includes('gradient')) {
    const grad = parseLinearGradient(style.backgroundImage);
    if (grad) return [linearGradientPaint(grad.stops, grad.angle)];
  }
  if (style.backgroundColor) return [solidFill(style.backgroundColor, style.backgroundAlpha ?? 1)];
  return undefined;
}

function strokesFor(style: SpecStyle): { strokes: unknown[]; strokeWeight: number; dashPattern?: number[] } | undefined {
  const b = style.border;
  if (!b || !b.width) return undefined;
  const { r, g, b: blue } = hexToRgb(b.color);
  const out: { strokes: unknown[]; strokeWeight: number; dashPattern?: number[] } = {
    strokes: [{ type: 'SOLID', color: { r, g, b: blue }, opacity: b.colorAlpha ?? 1 }],
    strokeWeight: b.width,
  };
  if (b.style === 'dashed') out.dashPattern = [b.width * 3, b.width * 2];
  else if (b.style === 'dotted') out.dashPattern = [b.width, b.width];
  return out;
}

function effectsFor(style: SpecStyle): unknown[] | undefined {
  const shadows = parseBoxShadow(style.boxShadow);
  if (!shadows.length) return undefined;
  return shadowEffects(shadows);
}

/** cornerRadius param: uniform number or [topLeft, topRight, bottomRight, bottomLeft]. */
function radiusParam(style: SpecStyle): number | number[] | undefined {
  const r = style.borderRadius;
  if (r === undefined) return undefined;
  if (typeof r === 'number') return r > 0 ? r : undefined;
  if (Array.isArray(r) && r.some((v) => v > 0)) return r;
  return undefined;
}

/** Shared visual-style params for frame/rectangle/image commands. */
function visualParams(style: SpecStyle, out: Record<string, unknown>) {
  const fills = fillsFor(style);
  if (fills) out.fills = fills;
  const strokes = strokesFor(style);
  if (strokes) {
    out.strokes = strokes.strokes;
    out.strokeWeight = strokes.strokeWeight;
    if (strokes.dashPattern) out.dashPattern = strokes.dashPattern;
  }
  const effects = effectsFor(style);
  if (effects) out.effects = effects;
  const radius = radiusParam(style);
  if (radius !== undefined) out.cornerRadius = radius;
  if (style.opacity !== undefined) out.opacity = style.opacity;
}

/**
 * Text auto-resize fallback for specs without an explicit marker (hand-written
 * / figma-rest): estimate the line count from box height vs line height.
 * Single-line → WIDTH_AND_HEIGHT (Figma sizes to content; fixed Chromium- or
 * hand-measured widths wrap under Figma's slightly wider glyph metrics).
 * Multi-line → HEIGHT (fixed width, wrapping preserved, height follows).
 */
export function textAutoResizeFor(el: ReplicaElement): 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE' {
  if (el.textAutoResize) return el.textAutoResize;
  const fontSize = el.style.fontSize ?? 16;
  const lh = typeof el.style.lineHeight === 'number' ? el.style.lineHeight : fontSize * 1.2;
  return el.rect.height / lh < 1.6 ? 'WIDTH_AND_HEIGHT' : 'HEIGHT';
}

function textParams(el: ReplicaElement, rel: { x: number; y: number }, k: (n: number) => number) {
  const s = el.style;
  // Full 100–900 → Figma style-name mapping (fontFromStyle); explicit
  // fontStyleName in the spec wins.
  const mapped = fontFromStyle({ fontFamily: s.fontFamily, fontWeight: s.fontWeight });
  const fontName = { family: mapped.family, style: s.fontStyleName || mapped.style };
  const params: Record<string, unknown> = {
    name: el.name,
    characters: (el.text ?? '').replace(/\s+/g, ' ').trim() || ' ',
    x: rel.x,
    y: rel.y,
    width: k(el.rect.width),
    height: k(el.rect.height),
    fontSize: s.fontSize ?? 16,
    fontName,
    textAutoResize: textAutoResizeFor(el),
    // Plugin tries these same-family styles (nearest weight first) before
    // falling back to Regular; degradations surface in result.warnings.
    fallbackStyles: fontFallbackChain(s.fontWeight).filter((st) => st !== fontName.style),
  };
  if (typeof s.letterSpacing === 'number') params.letterSpacing = { unit: 'PIXELS', value: s.letterSpacing };
  if (typeof s.lineHeight === 'number') params.lineHeight = { unit: 'PIXELS', value: s.lineHeight };
  const tc = textCaseFromStyle({ textTransform: s.textTransform });
  if (tc) params.textCase = tc;
  const align = textAlignFromStyle({ textAlign: s.textAlign });
  if (align) params.textAlignHorizontal = align;
  if (s.color) params.fills = [solidFill(s.color, s.colorAlpha ?? 1)];
  if (s.opacity !== undefined) params.opacity = s.opacity;
  return params;
}

const SVG_DATA_PREFIX = 'data:image/svg';

function looksLikeSvg(asset: ReplicaAsset | undefined, bytes?: Buffer): boolean {
  if (!asset) return false;
  if (asset.kind === 'svg') return true;
  const url = asset.url ?? '';
  if (url.startsWith(SVG_DATA_PREFIX)) return true;
  if (/\.svg(\?|#|$)/i.test(url)) return true;
  if (bytes) {
    const head = bytes.subarray(0, 256).toString('utf8');
    if (/^\s*</.test(head) && /<svg[\s>]/i.test(head)) return true;
  }
  return false;
}

/** Load asset bytes from data: / file: / http(s) URLs. */
async function loadAssetBytes(ctx: ToolContext, url: string): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const data = url.slice(comma + 1);
    return meta.includes(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
  }
  if (url.startsWith('file://')) {
    return fs.promises.readFile(decodeURIComponent(url.slice('file://'.length)));
  }
  return ctx.getClient().downloadBinary(url);
}

export interface BuildImportOptions {
  parentId?: string;
  /** Main frame landing position on the canvas/page (default 0,0). */
  x?: number;
  y?: number;
  scale?: number;
  includeImages?: boolean;
  maxImageBytes?: number;
  mainFrameName?: string;
  /** Drop leaf frames that carry no visual style at all (default: keep them as transparent containers). */
  skipEmptyFrames?: boolean;
}

/** Build the bridge command list for a replica spec (shared by dry-run and tests). */
export async function buildImportCommands(
  ctx: ToolContext,
  spec: ReplicaSpec,
  opts: BuildImportOptions = {},
): Promise<ImportPlan> {
  const scale = opts.scale ?? 1;
  const k = (n: number) => Math.round(n * scale * 100) / 100;
  const commands: BridgeCmd[] = [];
  const warnings: string[] = [];
  const stats: ImportStats = { sections: 0, texts: 0, images: 0, svgs: 0, backgrounds: 0, containers: 0, placeholders: 0 };

  const mainName = opts.mainFrameName ?? `${spec.node.name} (html-replica)`;
  const mainParams: Record<string, unknown> = {
    name: mainName,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: k(spec.canvas.width),
    height: k(spec.canvas.height),
    clipsContent: true,
  };
  if (opts.parentId) mainParams.parentId = opts.parentId;
  // Page background: gradient wins over solid (extractor keeps both when the
  // CSS background is a gradient over a base color).
  if (spec.canvas.backgroundImage?.includes('gradient')) {
    const grad = parseLinearGradient(spec.canvas.backgroundImage);
    if (grad) mainParams.fills = [linearGradientPaint(grad.stops, grad.angle)];
  }
  if (!mainParams.fills && spec.canvas.background) mainParams.fills = [solidFill(spec.canvas.background)];
  commands.push({ command: 'create_frame', params: mainParams, as: 'main' });

  const assetById = new Map(spec.assets.map((a) => [a.id, a]));

  const placeImage = async (el: ReplicaElement, parentVar: string, rel: { x: number; y: number }) => {
    const asset = el.assetId ? assetById.get(el.assetId) : undefined;
    let inserted = false;
    if (opts.includeImages !== false && asset?.url) {
      try {
        const buf = await loadAssetBytes(ctx, asset.url);
        if (looksLikeSvg(asset, buf)) {
          warnings.push(
            `svg "${el.name}" cannot be inserted (figma.createImage only supports raster bytes); ` +
              `created a placeholder — rasterize the SVG to PNG first`,
          );
        } else if (buf.length > (opts.maxImageBytes ?? 5 * 1024 * 1024)) {
          warnings.push(`image "${el.name}" skipped: ${buf.length} bytes exceeds maxImageBytes`);
        } else {
          const params: Record<string, unknown> = {
            parentId: parentVar,
            name: el.name,
            x: rel.x,
            y: rel.y,
            width: k(el.rect.width),
            height: k(el.rect.height),
            bytesBase64: buf.toString('base64'),
          };
          // Image corner radius native now: IMAGE-fill rectangle + cornerRadius.
          visualParams({ borderRadius: el.style.borderRadius, opacity: el.style.opacity, border: el.style.border }, params);
          commands.push({ command: 'insert_image', params });
          inserted = true;
          if (el.type === 'image') stats.images++;
          else stats.svgs++;
        }
      } catch (err) {
        warnings.push(`image "${el.name}" failed to load (${(err as Error).message}); created a placeholder`);
      }
    } else if (el.type === 'svg' || looksLikeSvg(asset)) {
      warnings.push(`svg "${el.name}" has no raster source; created a placeholder — rasterize the SVG to PNG first`);
    }
    if (!inserted) {
      stats.placeholders++;
      const params: Record<string, unknown> = {
        parentId: parentVar,
        name: `${el.type}:${el.name}`,
        x: rel.x,
        y: rel.y,
        width: k(el.rect.width),
        height: k(el.rect.height),
        fills: [solidFill('#e5e5e5')],
      };
      const radius = radiusParam(el.style);
      if (radius !== undefined) params.cornerRadius = radius;
      commands.push({ command: 'create_rectangle', params });
    }
  };

  /**
   * Place one element into `parentVar`; `parentAbs` is the parent frame's
   * page-absolute rect (spec coordinates) for coordinate conversion.
   */
  const placeElement = async (
    el: ReplicaElement,
    parentVar: string,
    parentAbs: { x: number; y: number },
  ): Promise<void> => {
    const rel = { x: k(el.rect.x - parentAbs.x), y: k(el.rect.y - parentAbs.y) };

    if (el.type === 'text') {
      if (!el.text?.trim()) return;
      stats.texts++;
      commands.push({ command: 'create_text', params: { ...textParams(el, rel, k), parentId: parentVar } });
      return;
    }

    if (el.type === 'image' || el.type === 'svg') {
      await placeImage(el, parentVar, rel);
      return;
    }

    // frame / button / input
    const hasChildren = (el.children?.length ?? 0) > 0;
    if (hasChildren) {
      stats.containers++;
      const varName = `f${commands.length}`;
      const params: Record<string, unknown> = {
        parentId: parentVar,
        name: el.name,
        x: rel.x,
        y: rel.y,
        width: k(el.rect.width),
        height: k(el.rect.height),
        clipsContent: el.clipsContent ?? true,
      };
      visualParams(el.style, params);
      commands.push({ command: 'create_frame', params, as: varName });
      for (const child of el.children ?? []) {
        await placeElement(child, `$${varName}`, el.rect);
      }
      return;
    }

    const hasVisual =
      !!fillsFor(el.style) || !!strokesFor(el.style) || !!effectsFor(el.style) || radiusParam(el.style) !== undefined;
    if (hasVisual) {
      // Leaf visual box → rectangle (supports fills/strokes/effects/radius).
      stats.backgrounds++;
      const params: Record<string, unknown> = {
        parentId: parentVar,
        name: el.name,
        x: rel.x,
        y: rel.y,
        width: k(el.rect.width),
        height: k(el.rect.height),
      };
      visualParams(el.style, params);
      if (!params.fills) params.fills = []; // strokes/effects-only boxes stay transparent inside
      commands.push({ command: 'create_rectangle', params });
      return;
    }

    // Leaf frame with no visual style: keep as a transparent container unless skipped.
    if (opts.skipEmptyFrames) return;
    stats.containers++;
    commands.push({
      command: 'create_frame',
      params: {
        parentId: parentVar,
        name: el.name,
        x: rel.x,
        y: rel.y,
        width: k(el.rect.width),
        height: k(el.rect.height),
        fills: [],
        clipsContent: el.clipsContent ?? false,
      },
    });
  };

  for (const section of spec.sections) {
    const rootEl = section.elements.find((e) => e.nodeId === section.id) ?? section.elements[0];
    // Degenerate section: a single non-frame leaf (loose image/svg/text) — place it
    // directly into the main frame at its absolute position, no wrapper frame.
    if (rootEl && section.elements.length === 1 && rootEl.type !== 'frame') {
      await placeElement(rootEl, '$main', { x: 0, y: 0 });
      continue;
    }

    stats.sections++;
    const secVar = `sec${stats.sections - 1}`;
    const secParams: Record<string, unknown> = {
      parentId: '$main',
      name: section.name,
      x: k(section.rect.x),
      y: k(section.rect.y),
      width: k(section.rect.width),
      height: k(section.rect.height),
      clipsContent: true,
    };
    visualParams(section.style, secParams);
    commands.push({ command: 'create_frame', params: secParams, as: secVar });

    if (rootEl?.children?.length) {
      // Nested mode: recurse the section root's child tree.
      for (const child of rootEl.children) {
        await placeElement(child, `$${secVar}`, section.rect);
      }
    } else {
      // Flat mode (figma-rest / hand-written specs): every element is a direct
      // child of the section frame at section-relative coordinates.
      for (const el of section.elements) {
        if (el === rootEl) continue;
        await placeElement(el, `$${secVar}`, section.rect);
      }
    }
  }
  return { commands, stats, warnings };
}

function stripBytes(commands: BridgeCmd[]): BridgeCmd[] {
  return commands.map((c) => ({
    ...c,
    params: c.params
      ? Object.fromEntries(Object.entries(c.params).map(([k, v]) => (k === 'bytesBase64' ? [k, `<${String(v).length} base64 chars>`] : [k, v])))
      : c.params,
  }));
}

interface BatchResultEntry {
  index: number;
  command: string;
  ok: boolean;
  result?: { nodeId?: string; fontApplied?: { family: string; style: string }; fontFallback?: string; warning?: string };
  error?: string;
}

/** Post-execution: turn per-command results into created-count + warnings. */
export function resolveBatchOutcome(plan: ImportPlan, batchResult: { results?: BatchResultEntry[] }): { created: number; warnings: string[] } {
  const warnings = [...plan.warnings];
  const results = batchResult?.results ?? [];
  let created = 0;
  for (const r of results) {
    if (!r.ok) {
      warnings.push(`command #${r.index} (${r.command}) failed: ${r.error ?? 'unknown error'}`);
      continue;
    }
    created++;
    if (r.result?.warning) warnings.push(r.result.warning);
    if (r.command === 'create_text' && r.result?.fontApplied) {
      const requested = (plan.commands[r.index]?.params?.fontName ?? {}) as { family?: string; style?: string };
      const applied = r.result.fontApplied;
      if (requested.family && (applied.family !== requested.family || applied.style !== requested.style)) {
        const label = String(plan.commands[r.index]?.params?.characters ?? '').slice(0, 24);
        warnings.push(
          `font degraded for "${label}": ${requested.family} ${requested.style} → ${applied.family} ${applied.style}` +
            (r.result.fontFallback ? ` (${r.result.fontFallback})` : ''),
        );
      }
    }
  }
  return { created, warnings };
}

export const importHtmlReplica: ToolDef = {
  name: 'import_html_replica',
  description:
    'Import an HTML page or a replica spec into Figma as native frames via the plugin bridge. ' +
    'Give it an HTML file (htmlPath) or URL (htmlUrl) and it extracts layout + computed styles with ' +
    'headless Chromium, then rebuilds: main frame → section frames → nested containers / text / image ' +
    'nodes with absolute positions, border-radius, borders, shadows, gradients, and real image bytes. ' +
    'Alternatively pass a ready-made spec (spec/specPath, from get_html_replica_spec or hand-written). ' +
    'All degradations (missing fonts, SVG assets, failed images) are reported in the warnings array. ' +
    'Supports dryRun to preview the command plan.',
  schema: {
    htmlPath: z.string().optional().describe('Path to a local .html file to extract and import (mutually exclusive with spec/specPath/htmlUrl).'),
    htmlUrl: z.string().optional().describe('http(s) URL to extract and import (mutually exclusive with spec/specPath/htmlPath).'),
    specPath: z.string().optional().describe('Path to a replica spec JSON.'),
    spec: z.union([z.string(), z.record(z.any())]).optional().describe('Inline spec JSON.'),
    viewportWidth: z.number().int().optional().describe('Extraction viewport width (default 1440).'),
    viewportHeight: z.number().int().optional().describe('Extraction viewport height (default 900).'),
    rootSelector: z.string().optional().describe('Extraction root element (default body).'),
    sectionSelector: z.string().optional().describe('Split the page into one section per matched element.'),
    outSpecPath: z.string().optional().describe('Write the extracted spec JSON to this path for inspection.'),
    x: z.number().optional().describe('Main frame landing X on the canvas (default 0).'),
    y: z.number().optional().describe('Main frame landing Y on the canvas (default 0).'),
    parentId: z.string().optional().describe('Target parent node id (default: current page).'),
    mainFrameName: z.string().optional(),
    scale: z.number().min(0.05).max(10).optional().default(1),
    includeImages: z.boolean().optional().default(true).describe('Download asset bytes and insert real images (default true).'),
    maxImageBytes: z.number().optional().describe('Per-image byte cap (default 5MB).'),
    skipEmptyFrames: z.boolean().optional().default(false).describe('Drop leaf frames with no visual style (default: keep as transparent containers).'),
    dryRun: z.boolean().optional().default(false).describe('Return the command plan without executing.'),
    timeoutMs: z.number().int().optional().describe('Bridge timeout for the whole batch (default 120000).'),
  },
  handler: async (ctx, args) => {
    const sources = [args.spec, args.specPath, args.htmlPath, args.htmlUrl].filter((v) => v !== undefined && v !== null);
    if (sources.length !== 1) {
      throw new Error('exactly one of htmlPath / htmlUrl / specPath / spec is required');
    }

    let spec: ReplicaSpec;
    const extractWarnings: string[] = [];
    if (args.htmlPath || args.htmlUrl) {
      const extracted = await extractHtmlToReplicaSpec({
        htmlPath: args.htmlPath ? path.resolve(args.htmlPath) : undefined,
        url: args.htmlUrl,
        viewport:
          args.viewportWidth || args.viewportHeight
            ? { width: args.viewportWidth ?? 1440, height: args.viewportHeight ?? 900 }
            : undefined,
        rootSelector: args.rootSelector,
        sectionSelector: args.sectionSelector,
      });
      spec = extracted.spec;
      extractWarnings.push(...extracted.warnings);
      if (args.outSpecPath) {
        const outPath = path.resolve(args.outSpecPath);
        fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
      }
    } else if (args.spec) {
      spec = typeof args.spec === 'string' ? JSON.parse(args.spec) : (args.spec as ReplicaSpec);
    } else {
      spec = JSON.parse(fs.readFileSync(path.resolve(args.specPath), 'utf8'));
    }

    const plan = await buildImportCommands(ctx, spec, args);
    plan.warnings.unshift(...extractWarnings);
    if (args.dryRun) {
      return textContent({
        dryRun: true,
        stats: plan.stats,
        warnings: plan.warnings,
        ...(args.outSpecPath && (args.htmlPath || args.htmlUrl) ? { specPath: path.resolve(args.outSpecPath) } : {}),
        commands: stripBytes(plan.commands),
      });
    }
    const result = (await ctx.bridge.execute(
      'batch',
      { commands: plan.commands, stopOnError: false },
      { timeoutMs: args.timeoutMs ?? 120_000 },
    )) as { results?: BatchResultEntry[] };
    const outcome = resolveBatchOutcome(plan, result);
    return textContent({
      stats: { ...plan.stats, created: outcome.created },
      warnings: outcome.warnings,
      batchResult: result,
    });
  },
};
