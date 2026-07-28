import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ReplicaSpec, ReplicaElement } from '../../replica/spec';
import { hexToRgb, parseLinearGradient, linearGradientPaint, textCaseFromStyle } from '../../replica/css';
import { textContent, type ToolDef, type ToolContext } from '../common';

interface BridgeCmd {
  command: string;
  params?: Record<string, unknown>;
  as?: string;
}

function solidFill(hex: string, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  return { type: 'SOLID', color: { r, g, b }, opacity: alpha };
}

function fillsFor(el: ReplicaElement): unknown[] | undefined {
  const s = el.style;
  if (s.backgroundImage && s.backgroundImage.includes('gradient')) {
    const grad = parseLinearGradient(s.backgroundImage);
    if (grad) return [linearGradientPaint(grad.stops, grad.angle)];
  }
  if (s.backgroundColor) return [solidFill(s.backgroundColor, s.backgroundAlpha ?? 1)];
  return undefined;
}

function textParams(el: ReplicaElement, rel: { x: number; y: number }) {
  const s = el.style;
  const fontStyle = s.fontStyleName || (s.fontWeight && s.fontWeight >= 700 ? 'Bold' : s.fontWeight === 300 ? 'Light' : s.fontWeight && s.fontWeight >= 600 ? 'SemiBold' : s.fontWeight && s.fontWeight >= 500 ? 'Medium' : 'Regular');
  const params: Record<string, unknown> = {
    name: el.name,
    characters: (el.text ?? '').replace(/\s+/g, ' ').trim() || ' ',
    x: rel.x,
    y: rel.y,
    width: el.rect.width,
    height: el.rect.height,
    fontSize: s.fontSize ?? 16,
    fontName: { family: s.fontFamily ?? 'Inter', style: fontStyle },
  };
  if (typeof s.letterSpacing === 'number') params.letterSpacing = { unit: 'PIXELS', value: s.letterSpacing };
  if (typeof s.lineHeight === 'number') params.lineHeight = { unit: 'PIXELS', value: s.lineHeight };
  const tc = textCaseFromStyle({ textTransform: s.textTransform });
  if (tc) params.textCase = tc;
  if (s.textAlign) params.textAlignHorizontal = s.textAlign.toUpperCase();
  if (s.color) params.fills = [solidFill(s.color, s.colorAlpha ?? 1)];
  return params;
}

export interface ImportPlan {
  commands: BridgeCmd[];
  stats: { sections: number; texts: number; images: number; svgs: number; backgrounds: number; placeholders: number };
}

/** Build the bridge command list for a replica spec (shared by dry-run and tests). */
export async function buildImportCommands(
  ctx: ToolContext,
  spec: ReplicaSpec,
  opts: { parentId?: string; scale?: number; includeImages?: boolean; maxImageBytes?: number; mainFrameName?: string } = {},
): Promise<ImportPlan> {
  const scale = opts.scale ?? 1;
  const k = (n: number) => Math.round(n * scale * 100) / 100;
  const commands: BridgeCmd[] = [];
  const stats = { sections: 0, texts: 0, images: 0, svgs: 0, backgrounds: 0, placeholders: 0 };

  const mainName = opts.mainFrameName ?? `${spec.node.name} (html-replica)`;
  const mainParams: Record<string, unknown> = {
    name: mainName,
    x: 0,
    y: 0,
    width: k(spec.canvas.width),
    height: k(spec.canvas.height),
    clipsContent: true,
  };
  if (opts.parentId) mainParams.parentId = opts.parentId;
  if (spec.canvas.background) mainParams.fills = [solidFill(spec.canvas.background)];
  commands.push({ command: 'create_frame', params: mainParams, as: 'main' });

  const assetById = new Map(spec.assets.map((a) => [a.id, a]));

  const placeElement = async (el: ReplicaElement, parentVar: string, rel: { x: number; y: number }) => {
    if (el.type === 'text' && el.text?.trim()) {
      stats.texts++;
      commands.push({ command: 'create_text', params: { ...textParams(el, rel), parentId: parentVar } });
      return;
    }

    if (el.type === 'image' || el.type === 'svg') {
      const asset = el.assetId ? assetById.get(el.assetId) : undefined;
      let inserted = false;
      if (opts.includeImages !== false && asset?.url) {
        try {
          const buf = await ctx.getClient().downloadBinary(asset.url);
          if (buf.length <= (opts.maxImageBytes ?? 5 * 1024 * 1024)) {
            commands.push({
              command: 'insert_image',
              params: {
                parentId: parentVar,
                name: el.name,
                x: rel.x,
                y: rel.y,
                width: k(el.rect.width),
                height: k(el.rect.height),
                bytesBase64: buf.toString('base64'),
              },
            });
            inserted = true;
            if (el.type === 'image') stats.images++;
            else stats.svgs++;
          }
        } catch {
          /* fall through to placeholder */
        }
      }
      if (!inserted) {
        stats.placeholders++;
        commands.push({
          command: 'create_rectangle',
          params: {
            parentId: parentVar,
            name: `${el.type}:${el.name}`,
            x: rel.x,
            y: rel.y,
            width: k(el.rect.width),
            height: k(el.rect.height),
            fills: [solidFill('#e5e5e5')],
          },
        });
      }
      return;
    }

    const fills = fillsFor(el);
    if (el.type === 'frame' && fills) {
      stats.backgrounds++;
      commands.push({
        command: 'create_rectangle',
        params: { parentId: parentVar, name: el.name, x: rel.x, y: rel.y, width: k(el.rect.width), height: k(el.rect.height), fills },
      });
    }
  };

  for (const section of spec.sections) {
    const rootEl = section.elements.find((e) => e.nodeId === section.id);
    // Degenerate section: a single non-frame leaf (loose image/svg/text) — place it
    // directly into the main frame at its absolute position, no wrapper frame.
    if (rootEl && section.elements.length === 1 && rootEl.type !== 'frame') {
      await placeElement(rootEl, '$main', { x: k(rootEl.rect.x), y: k(rootEl.rect.y) });
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
    const secFills = fillsFor({ style: section.style } as ReplicaElement);
    if (secFills) secParams.fills = secFills;
    commands.push({ command: 'create_frame', params: secParams, as: secVar });

    for (const el of section.elements) {
      if (el.nodeId === section.id) continue; // the section frame itself
      const rel = { x: k(el.rect.x - section.rect.x), y: k(el.rect.y - section.rect.y) };
      await placeElement(el, `$${secVar}`, rel);
    }
  }
  return { commands, stats };
}

function stripBytes(commands: BridgeCmd[]): BridgeCmd[] {
  return commands.map((c) => ({
    ...c,
    params: c.params
      ? Object.fromEntries(Object.entries(c.params).map(([k, v]) => (k === 'bytesBase64' ? [k, `<${String(v).length} base64 chars>`] : [k, v])))
      : c.params,
  }));
}

export const importHtmlReplica: ToolDef = {
  name: 'import_html_replica',
  description:
    'Rebuild a replica spec (from get_html_replica_spec) as native Figma frames via the plugin bridge: main frame ' +
    '→ section frames → text/image/svg/background nodes with absolute positions and computed styles. ' +
    'Supports dryRun to preview the command plan.',
  schema: {
    specPath: z.string().optional().describe('Path to a replica spec JSON.'),
    spec: z.union([z.string(), z.record(z.any())]).optional().describe('Inline spec JSON.'),
    parentId: z.string().optional().describe('Target parent node id (default: current page).'),
    mainFrameName: z.string().optional(),
    scale: z.number().min(0.05).max(10).optional().default(1),
    includeImages: z.boolean().optional().default(true).describe('Download asset bytes and insert real images (default true).'),
    maxImageBytes: z.number().optional().describe('Per-image byte cap (default 5MB).'),
    dryRun: z.boolean().optional().default(false).describe('Return the command plan without executing.'),
    timeoutMs: z.number().int().optional().describe('Bridge timeout for the whole batch (default 120000).'),
  },
  handler: async (ctx, args) => {
    let spec: ReplicaSpec;
    if (args.spec) spec = typeof args.spec === 'string' ? JSON.parse(args.spec) : (args.spec as ReplicaSpec);
    else if (args.specPath) spec = JSON.parse(fs.readFileSync(path.resolve(args.specPath), 'utf8'));
    else throw new Error('specPath or spec is required');

    const plan = await buildImportCommands(ctx, spec, args);
    if (args.dryRun) {
      return textContent({ dryRun: true, stats: plan.stats, commands: stripBytes(plan.commands) });
    }
    const result = await ctx.bridge.execute(
      'batch',
      { commands: plan.commands, stopOnError: false },
      { timeoutMs: args.timeoutMs ?? 120_000 },
    );
    return textContent({ stats: plan.stats, batchResult: result });
  },
};
