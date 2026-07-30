import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ReplicaAsset, ReplicaElement, ReplicaSpec, SpecStyle, SpecTextRun } from '../../replica/spec';
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
import { diffPngBuffers } from '../../replica/visualDiff';
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
  // HTML semantics: an element without a background is TRANSPARENT. Figma's
  // default frame/rect fill is white, so we must explicitly clear fills —
  // otherwise unstyled containers paint an opaque white sheet over siblings.
  out.fills = fills ?? [];
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
  const hasRuns = (el.runs?.length ?? 0) >= 2;
  const autoResize = textAutoResizeFor(el);
  const params: Record<string, unknown> = {
    name: el.name,
    // Runs path: keep the extractor-normalized text verbatim (run-boundary
    // whitespace preserved); legacy path: whitespace-collapsed.
    characters: hasRuns ? el.runs!.map((r) => r.text).join('') || ' ' : (el.text ?? '').replace(/\s+/g, ' ').trim() || ' ',
    x: rel.x,
    y: rel.y,
    width: k(el.rect.width),
    height: k(el.rect.height),
    fontSize: s.fontSize ?? 16,
    fontName,
    textAutoResize: autoResize,
    // Plugin tries these same-family styles (nearest weight first) before
    // falling back to Regular; degradations surface in result.warnings.
    fallbackStyles: fontFallbackChain(s.fontWeight).filter((st) => st !== fontName.style),
  };
  if (el.anchorRight && autoResize === 'WIDTH_AND_HEIGHT') params.anchorRight = true;
  if (hasRuns) {
    let off = 0;
    const runs: Array<Record<string, unknown>> = [];
    for (const r of el.runs as SpecTextRun[]) {
      const start = off;
      off += r.text.length;
      if (!r.text) continue;
      const runMapped = fontFromStyle({ fontFamily: r.fontFamily ?? s.fontFamily, fontWeight: r.fontWeight ?? s.fontWeight });
      const runFont = { family: runMapped.family, style: r.fontStyleName || runMapped.style };
      const run: Record<string, unknown> = {
        start,
        end: off,
        fontName: runFont,
        fallbackStyles: fontFallbackChain(r.fontWeight ?? s.fontWeight).filter((st) => st !== runFont.style),
      };
      if (r.color) run.fills = [solidFill(r.color, r.colorAlpha ?? 1)];
      runs.push(run);
    }
    if (runs.length) params.runs = runs;
  }
  if (typeof s.letterSpacing === 'number') params.letterSpacing = { unit: 'PIXELS', value: s.letterSpacing };
  // Single-line (WIDTH_AND_HEIGHT) texts intentionally drop the explicit
  // PIXELS line height: with a fallback font Figma places the glyphs inside
  // the fixed line box differently than Chromium did (icon/text rows ended up
  // vertically misaligned). AUTO line height gives the font's natural box and
  // the plugin recenters that box on the browser slot (see create_text).
  // Multi-line/legacy texts keep PIXELS line height (wrap + leading fidelity).
  if (typeof s.lineHeight === 'number' && autoResize !== 'WIDTH_AND_HEIGHT') {
    params.lineHeight = { unit: 'PIXELS', value: s.lineHeight };
  }
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

/** Per-image download timeout (remote URLs only). */
export const IMAGE_TIMEOUT_MS = 15_000;
/** Default image prefetch concurrency. */
export const IMAGE_CONCURRENCY = 6;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Load asset bytes from data: / file: / plain fs paths / http(s) URLs. */
async function loadAssetBytes(ctx: ToolContext, url: string, timeoutMs = IMAGE_TIMEOUT_MS): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const data = url.slice(comma + 1);
    return meta.includes(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
  }
  if (url.startsWith('file://')) {
    return fs.promises.readFile(decodeURIComponent(url.slice('file://'.length)));
  }
  if (/^https?:\/\//i.test(url)) {
    return withTimeout(ctx.getClient().downloadBinary(url), timeoutMs, `download ${url}`);
  }
  // No scheme: treat as a local filesystem path (hand-written specs).
  return fs.promises.readFile(path.resolve(url));
}

export interface AssetFetchResult {
  bytes?: Buffer;
  error?: string;
  retried?: boolean;
}

/**
 * One URL through the fallback chain: download (15s timeout for remote) → one
 * serial retry → error. Never throws.
 */
async function fetchAssetBytes(ctx: ToolContext, url: string, timeoutMs: number): Promise<AssetFetchResult> {
  try {
    return { bytes: await loadAssetBytes(ctx, url, timeoutMs) };
  } catch (err) {
    const first = (err as Error).message;
    try {
      const bytes = await loadAssetBytes(ctx, url, timeoutMs);
      return { bytes, retried: true };
    } catch (err2) {
      return { error: `${first}; retry: ${(err2 as Error).message}` };
    }
  }
}

/**
 * Concurrent prefetch pool for asset bytes (default 6 in flight). A failure of
 * the pool machinery itself degrades the whole batch to the legacy serial
 * path — downloads never abort an import.
 */
export async function prefetchAssetBytes(
  ctx: ToolContext,
  urls: string[],
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<{ results: Map<string, AssetFetchResult>; pooled: boolean }> {
  const concurrency = Math.max(1, opts.concurrency ?? IMAGE_CONCURRENCY);
  const timeoutMs = opts.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const results = new Map<string, AssetFetchResult>();
  try {
    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const url = urls[idx++];
        results.set(url, await fetchAssetBytes(ctx, url, timeoutMs));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
    return { results, pooled: true };
  } catch {
    // Pool-level failure: serial fallback, same per-image chain.
    for (const url of urls) {
      if (!results.has(url)) results.set(url, await fetchAssetBytes(ctx, url, timeoutMs));
    }
    return { results, pooled: false };
  }
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
  /** Drop leaf frames that carry no visual style at all (default: drop them). */
  skipEmptyFrames?: boolean;
  /** Concurrent image downloads while prefetching (default 6). */
  imageConcurrency?: number;
  /** Per-image download timeout in ms (default 15000). */
  imageTimeoutMs?: number;
}

/** Walk the spec tree, collecting every referenced asset (deduped by id). */
function collectAssets(spec: ReplicaSpec): ReplicaAsset[] {
  const byId = new Map(spec.assets.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const out: ReplicaAsset[] = [];
  const visit = (el: ReplicaElement) => {
    if (el.assetId && !seen.has(el.assetId)) {
      seen.add(el.assetId);
      const asset = byId.get(el.assetId);
      if (asset?.url) out.push(asset);
    }
    el.children?.forEach(visit);
  };
  for (const section of spec.sections) section.elements.forEach(visit);
  return out;
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

  // Prefetch all asset bytes up front (concurrent pool, serial fallback), so
  // command construction afterwards stays ordered and synchronous-looking.
  const referencedAssets = opts.includeImages === false ? [] : collectAssets(spec);
  const urls = Array.from(new Set(referencedAssets.map((a) => a.url!)));
  const prefetched = urls.length
    ? await prefetchAssetBytes(ctx, urls, { concurrency: opts.imageConcurrency, timeoutMs: opts.imageTimeoutMs })
    : { results: new Map<string, AssetFetchResult>(), pooled: true };
  if (!prefetched.pooled) warnings.push('image prefetch pool failed; fell back to serial downloads');
  for (const [url, r] of prefetched.results) {
    if (r.retried) warnings.push(`image ${url} downloaded on retry`);
  }
  // Content-hash dedupe: identical bytes (same or different URLs) transfer to
  // the plugin once; later references send only `imageHash`.
  const sentHashes = new Set<string>();

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
      let buf: Buffer | undefined = prefetched.results.get(asset.url)?.bytes;
      let loadError = prefetched.results.get(asset.url)?.error;
      // Fallback chain continues: extraction-side rasterized copy ↔ original bytes.
      if (!buf && asset.originalUrl) {
        const alt = await fetchAssetBytes(ctx, asset.originalUrl, opts.imageTimeoutMs ?? IMAGE_TIMEOUT_MS);
        if (alt.bytes) {
          buf = alt.bytes;
          warnings.push(`image "${el.name}" raster copy failed; used original bytes from ${asset.originalUrl}`);
        } else {
          loadError = `${loadError ?? 'load failed'}; originalUrl: ${alt.error ?? 'failed'}`;
        }
      }
      if (!buf) {
        warnings.push(`image "${el.name}" failed to load (${loadError ?? 'unknown error'}); created a placeholder`);
      } else if (looksLikeSvg(asset, buf)) {
        warnings.push(
          `svg "${el.name}" cannot be inserted (figma.createImage only supports raster bytes); ` +
            `created a placeholder — rasterize the SVG to PNG first`,
        );
      } else if (buf.length > (opts.maxImageBytes ?? 5 * 1024 * 1024)) {
        warnings.push(`image "${el.name}" skipped: ${buf.length} bytes exceeds maxImageBytes`);
      } else {
        const contentHash = createHash('sha256').update(buf).digest('hex');
        const alreadySent = sentHashes.has(contentHash);
        sentHashes.add(contentHash);
        const params: Record<string, unknown> = {
          parentId: parentVar,
          name: el.name,
          x: rel.x,
          y: rel.y,
          width: k(el.rect.width),
          height: k(el.rect.height),
          imageHash: contentHash,
        };
        // Hash-reuse protocol: the plugin caches contentHash → figma Image;
        // duplicates skip the base64 transfer entirely.
        if (!alreadySent) params.bytesBase64 = buf.toString('base64');
        // Image corner radius native now: IMAGE-fill rectangle + cornerRadius.
        visualParams({ borderRadius: el.style.borderRadius, opacity: el.style.opacity, border: el.style.border }, params);
        commands.push({ command: 'insert_image', params });
        inserted = true;
        if (el.type === 'image') stats.images++;
        else stats.svgs++;
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
        // CSS default overflow is VISIBLE: children and box-shadows paint
        // outside the element's box (e.g. a card whose giant same-color
        // drop-shadow extends its background to the viewport edge). Default
        // to NOT clipping; the extractor sets clipsContent:true only where
        // computed overflow is hidden/scroll/auto/clip.
        clipsContent: el.clipsContent ?? false,
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

    // Leaf frame with no visual style: dropped by default (item 13); kept as a
    // transparent container only with skipEmptyFrames:false.
    if (opts.skipEmptyFrames !== false) return;
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
  result?: { nodeId?: string; fontApplied?: { family: string; style: string }; fontFallback?: string; warning?: string; warnings?: string[] };
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
    if (Array.isArray(r.result?.warnings)) warnings.push(...r.result.warnings);
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
    imageConcurrency: z.number().int().min(1).optional().describe('Concurrent image downloads while prefetching (default 6).'),
    skipEmptyFrames: z.boolean().optional().default(true).describe('Drop leaf frames with no visual style (default true; pass false to keep them as transparent containers).'),
    includeHidden: z.boolean().optional().default(false).describe('Keep off-canvas / overflow-clipped elements (e.g. hidden carousel slides) during extraction (default false).'),
    replaceExisting: z.boolean().optional().default(true).describe('Delete same-named top-level frames before importing (idempotent re-imports; default true).'),
    verifyAfterImport: z.boolean().optional().default(false).describe('After the batch, export the main frame PNG and pixel-diff it against a fresh source screenshot (per-section report).'),
    dryRun: z.boolean().optional().default(false).describe('Return the command plan without executing.'),
    timeoutMs: z.number().int().optional().describe('Explicit total bridge timeout for the batch (default: adaptive max(120s, commandCount × 300ms); idle heartbeat timeout stays the primary breaker).'),
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
        includeHidden: args.includeHidden,
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

    // Idempotent re-imports: drop same-named top-level frames first.
    const mainName = args.mainFrameName ?? `${spec.node.name} (html-replica)`;
    if (args.replaceExisting !== false) {
      try {
        const listing = (await ctx.bridge.execute('get_page_children', args.parentId ? { nodeId: args.parentId } : {}, { timeoutMs: 15_000 })) as {
          children?: Array<{ id: string; name: string }>;
        };
        const dupes = (listing?.children ?? []).filter((c) => c.name === mainName);
        for (const d of dupes) {
          await ctx.bridge.execute('delete_node', { nodeId: d.id }, { timeoutMs: 15_000 });
        }
        if (dupes.length) plan.warnings.push(`replaceExisting: deleted ${dupes.length} existing frame(s) named "${mainName}"`);
      } catch (err) {
        plan.warnings.push(`replaceExisting check failed (${(err as Error).message}); importing without cleanup`);
      }
    }

    const result = (await ctx.bridge.execute(
      'batch',
      { commands: plan.commands, stopOnError: false },
      { timeoutMs: args.timeoutMs },
    )) as { results?: BatchResultEntry[] };
    const outcome = resolveBatchOutcome(plan, result);

    // Post-import self-check: REST-free visual diff (plugin export vs fresh
    // source screenshot), split per spec section.
    let verification: Record<string, unknown> | undefined;
    if (args.verifyAfterImport) {
      try {
        const mainNodeId = result.results?.[0]?.result?.nodeId;
        if (!mainNodeId) throw new Error('main frame node id missing from batch results');
        const exported = (await ctx.bridge.execute('export_node', { nodeId: mainNodeId, format: 'PNG', scale: args.scale ?? 1 }, { timeoutMs: 60_000 })) as {
          base64?: string;
        };
        if (!exported?.base64) throw new Error('export_node returned no image bytes');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-verify-'));
        const shotPath = path.join(tmp, 'source.png');
        const { renderScreenshot } = await import('../../replica/render');
        await renderScreenshot({
          htmlPath: args.htmlPath ? path.resolve(args.htmlPath) : undefined,
          url: args.htmlUrl,
          viewport: {
            width: args.viewportWidth ?? 1440,
            height: args.viewportHeight ?? 900,
          },
          outPath: shotPath,
        });
        const scale = args.scale ?? 1;
        // Region-aware verification: a full-page average dilutes localized
        // errors (an 80px-wide wrong right edge is ~4% of pixels and used to
        // PASS the old 5% global gate). Split the page into horizontal bands
        // plus dedicated left/right edge strips so a localized mistake fails
        // loudly and the report says WHERE it is.
        const cw = spec.canvas.width * scale;
        const ch = spec.canvas.height * scale;
        const edgeW = Math.max(60, Math.round(cw * 0.08));
        const nBands = 8;
        const bandH = Math.ceil(ch / nBands);
        const bands: { name: string; y0: number; y1: number; x0?: number; x1?: number }[] = [];
        for (let i = 0; i < nBands; i++) {
          bands.push({ name: `band${i + 1}/${nBands}`, y0: i * bandH, y1: Math.min(ch, (i + 1) * bandH) });
        }
        bands.push({ name: 'LEFT-EDGE', y0: 0, y1: ch, x0: 0, x1: edgeW });
        bands.push({ name: 'RIGHT-EDGE', y0: 0, y1: ch, x0: cw - edgeW, x1: cw });
        const diff = diffPngBuffers(fs.readFileSync(shotPath), Buffer.from(exported.base64, 'base64'), bands);
        const GLOBAL_MAX = 0.02;
        const BAND_MAX = 0.05;
        const EDGE_MAX = 0.03;
        const isEdge = (n: string) => n.endsWith('-EDGE');
        const failedRegions = diff.bands.filter((b) => b.ratio > (isEdge(b.name) ? EDGE_MAX : BAND_MAX));
        const passed = diff.diffRatio <= GLOBAL_MAX && failedRegions.length === 0;
        verification = {
          passed,
          diffRatio: Math.round(diff.diffRatio * 1e6) / 1e6,
          sizeMismatch: diff.sizeMismatch,
          thresholds: { global: GLOBAL_MAX, band: BAND_MAX, edge: EDGE_MAX },
          ...(failedRegions.length
            ? { failedRegions: failedRegions.map((b) => ({ region: b.name, ratio: Math.round(b.ratio * 1e4) / 1e4 })) }
            : {}),
          regions: diff.bands.map((b) => ({ name: b.name, ratio: Math.round(b.ratio * 1e6) / 1e6 })),
        };
        if (!passed) {
          outcome.warnings.push(
            `verifyAfterImport: visual diff above threshold (${(diff.diffRatio * 100).toFixed(2)}% global` +
              (failedRegions.length ? `; worst regions: ${failedRegions.map((b) => `${b.name} ${(b.ratio * 100).toFixed(1)}%`).join(', ')}` : '') +
              `)`,
          );
        }
      } catch (err) {
        outcome.warnings.push(`verifyAfterImport failed: ${(err as Error).message}`);
        verification = { passed: false, error: (err as Error).message };
      }
    }

    return textContent({
      stats: { ...plan.stats, created: outcome.created },
      warnings: outcome.warnings,
      ...(verification ? { verification } : {}),
      batchResult: result,
    });
  },
};
