/**
 * Raw Figma REST node → simplified design context.
 * Keeps: absolute bounds, auto-layout, fills/strokes/effects, text styles.
 */

export interface SimplifiedPaint {
  type: 'solid' | 'gradient_linear' | 'gradient_radial' | 'gradient_angular' | 'gradient_diamond' | 'image' | 'other';
  color?: string; // hex
  alpha?: number;
  stops?: Array<{ position: number; color: string; alpha: number }>;
  transform?: number[][];
  imageRef?: string;
  scaleMode?: string;
  opacity?: number;
  raw?: string;
}

export interface SimplifiedEffect {
  type: string;
  radius?: number;
  offset?: { x: number; y: number };
  spread?: number;
  color?: string;
  alpha?: number;
  visible?: boolean;
}

export interface SimplifiedNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  opacity?: number;
  cornerRadius?: number | number[];
  clipsContent?: boolean;
  layout?: {
    mode: 'row' | 'column' | 'none';
    wrap?: boolean;
    gap?: number;
    counterGap?: number;
    padding?: { top: number; right: number; bottom: number; left: number };
    alignPrimary?: string;
    alignCounter?: string;
    sizingPrimary?: string;
    sizingCounter?: string;
  };
  fills?: SimplifiedPaint[];
  strokes?: SimplifiedPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: SimplifiedEffect[];
  text?: {
    characters: string;
    fontFamily?: string;
    fontStyle?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    lineHeightPercent?: number;
    letterSpacingPx?: number;
    textCase?: string;
    textAlignHorizontal?: string;
    textAlignVertical?: string;
    textDecoration?: string;
  };
  componentId?: string;
  styleRefs?: Record<string, string>;
  childrenTruncated?: number;
  children?: SimplifiedNode[];
}

type RawNode = Record<string, any>;

export function rgbToHex(c: { r: number; g: number; b: number } | undefined): string {
  if (!c) return '#000000';
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function simplifyPaint(p: any): SimplifiedPaint | undefined {
  if (!p || p.visible === false) return undefined;
  const opacity = p.opacity ?? 1;
  switch (p.type) {
    case 'SOLID':
      return { type: 'solid', color: rgbToHex(p.color), alpha: (p.color?.a ?? 1) * opacity, opacity };
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND':
      return {
        type: p.type.toLowerCase() as SimplifiedPaint['type'],
        stops: (p.gradientStops ?? []).map((s: any) => ({
          position: s.position,
          color: rgbToHex(s.color),
          alpha: s.color?.a ?? 1,
        })),
        transform: p.gradientHandlePositions ? undefined : p.gradientTransform,
        opacity,
      };
    case 'IMAGE':
      return { type: 'image', imageRef: p.imageRef, scaleMode: p.scaleMode, opacity };
    default:
      return { type: 'other', raw: p.type };
  }
}

export function simplifyEffect(e: any): SimplifiedEffect {
  return {
    type: e.type,
    radius: e.radius,
    offset: e.offset,
    spread: e.spread,
    color: e.color ? rgbToHex(e.color) : undefined,
    alpha: e.color?.a,
    visible: e.visible !== false,
  };
}

function layoutOf(n: RawNode): SimplifiedNode['layout'] | undefined {
  const mode = n.layoutMode;
  if (!mode || mode === 'NONE') {
    if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'SECTION') {
      return { mode: 'none' };
    }
    return undefined;
  }
  return {
    mode: mode === 'HORIZONTAL' ? 'row' : 'column',
    wrap: n.layoutWrap === 'WRAP' || undefined,
    gap: n.itemSpacing,
    counterGap: n.counterAxisSpacing,
    padding:
      n.paddingLeft !== undefined
        ? { top: n.paddingTop ?? 0, right: n.paddingRight ?? 0, bottom: n.paddingBottom ?? 0, left: n.paddingLeft ?? 0 }
        : undefined,
    alignPrimary: n.primaryAxisAlignItems,
    alignCounter: n.counterAxisAlignItems,
    sizingPrimary: n.primaryAxisSizingMode,
    sizingCounter: n.counterAxisSizingMode,
  };
}

function textOf(n: RawNode): SimplifiedNode['text'] | undefined {
  if (n.type !== 'TEXT') return undefined;
  const s = n.style ?? {};
  return {
    characters: n.characters ?? '',
    fontFamily: s.fontFamily,
    fontStyle: s.fontPostScriptName?.split('-')[1] ?? s.fontStyle,
    fontWeight: s.fontWeight,
    fontSize: s.fontSize,
    lineHeightPx: s.lineHeightPx,
    lineHeightPercent: s.lineHeightPercentFontSize,
    letterSpacingPx: s.letterSpacing,
    textCase: s.textCase,
    textAlignHorizontal: s.textAlignHorizontal,
    textAlignVertical: s.textAlignVertical,
    textDecoration: s.textDecoration,
  };
}

export interface SimplifyOptions {
  depth?: number; // max recursion depth (default Infinity)
}

export function simplifyNode(node: RawNode, opts: SimplifyOptions = {}, depth = 0): SimplifiedNode {
  const b = node.absoluteBoundingBox ?? node.absoluteRenderBounds ?? { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 };
  const fills = Array.isArray(node.fills) ? node.fills.map(simplifyPaint).filter(Boolean) as SimplifiedPaint[] : undefined;
  const strokes = Array.isArray(node.strokes) ? node.strokes.map(simplifyPaint).filter(Boolean) as SimplifiedPaint[] : undefined;
  const out: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== false,
    bounds: { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) },
    opacity: node.opacity !== undefined && node.opacity !== 1 ? node.opacity : undefined,
    cornerRadius: node.cornerRadius ?? node.rectangleCornerRadii,
    clipsContent: node.clipsContent === true ? true : undefined,
    layout: layoutOf(node),
    fills: fills?.length ? fills : undefined,
    strokes: strokes?.length ? strokes : undefined,
    strokeWeight: node.strokeWeight,
    strokeAlign: node.strokeAlign !== 'INSIDE' ? node.strokeAlign : undefined,
    effects: Array.isArray(node.effects) && node.effects.length ? node.effects.map(simplifyEffect) : undefined,
    text: textOf(node),
    componentId: node.componentId,
    styleRefs: node.styles,
  };
  const kids: RawNode[] = Array.isArray(node.children) ? node.children : [];
  const maxDepth = opts.depth ?? Infinity;
  if (depth + 1 >= maxDepth && kids.length) {
    out.childrenTruncated = kids.length;
  } else if (kids.length) {
    out.children = kids.map((k) => simplifyNode(k, opts, depth + 1));
  }
  return out;
}

function round2(n: number): number {
  return Math.round((n ?? 0) * 100) / 100;
}

/** Lightweight metadata projection (id, name, type, bounds). */
export interface MetadataNode {
  id: string;
  name: string;
  type: string;
  bounds: { x: number; y: number; width: number; height: number };
  childCount?: number;
  children?: MetadataNode[];
}

export function metadataNode(node: RawNode, opts: SimplifyOptions = {}, depth = 0): MetadataNode {
  const b = node.absoluteBoundingBox ?? { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 };
  const kids: RawNode[] = Array.isArray(node.children) ? node.children.filter((c: any) => c.visible !== false) : [];
  const maxDepth = opts.depth ?? Infinity;
  const out: MetadataNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    bounds: { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) },
  };
  if (depth + 1 >= maxDepth) {
    if (kids.length) out.childCount = kids.length;
  } else if (kids.length) {
    out.children = kids.map((k) => metadataNode(k, opts, depth + 1));
  }
  return out;
}

export function metadataToXml(node: MetadataNode, indent = ''): string {
  const { x, y, width, height } = node.bounds;
  const attrs = `id="${esc(node.id)}" name="${esc(node.name)}" type="${esc(node.type)}" x="${x}" y="${y}" width="${width}" height="${height}"`;
  if (!node.children?.length) {
    const cc = node.childCount ? ` childCount="${node.childCount}"` : '';
    return `${indent}<node ${attrs}${cc}/>`;
  }
  const inner = node.children.map((c) => metadataToXml(c, `${indent}  `)).join('\n');
  return `${indent}<node ${attrs}>\n${inner}\n${indent}</node>`;
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Compact text rendering of a simplified tree (for format: 'compact'). */
export function simplifiedToCompact(node: SimplifiedNode, indent = ''): string {
  const b = node.bounds;
  const parts = [`${node.type} "${node.name}" #${node.id} [${b.x},${b.y} ${b.width}x${b.height}]`];
  if (node.layout && node.layout.mode !== 'none') {
    parts.push(`layout=${node.layout.mode} gap=${node.layout.gap ?? 0}`);
    if (node.layout.padding) {
      const p = node.layout.padding;
      parts.push(`pad=${p.top},${p.right},${p.bottom},${p.left}`);
    }
  }
  if (node.fills?.length) parts.push(`fills=${node.fills.map(paintBrief).join('|')}`);
  if (node.text) {
    const t = node.text;
    parts.push(`text=${JSON.stringify(truncate(t.characters, 60))} font=${t.fontFamily} ${t.fontStyle ?? ''} ${t.fontSize}px`);
  }
  let out = indent + parts.join(' ');
  if (node.childrenTruncated) out += `\n${indent}  … ${node.childrenTruncated} children truncated`;
  for (const c of node.children ?? []) out += `\n${simplifiedToCompact(c, `${indent}  `)}`;
  return out;
}

function paintBrief(p: SimplifiedPaint): string {
  if (p.type === 'solid') return `${p.color}${p.alpha !== undefined && p.alpha < 1 ? `@${p.alpha.toFixed(2)}` : ''}`;
  if (p.type === 'image') return `image(${p.imageRef})`;
  return p.type;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Walk a simplified (or raw) tree; visitor returns false to skip children. */
export function walkRaw(node: RawNode, visit: (n: RawNode, depth: number) => void, depth = 0): void {
  if (!node || node.visible === false) return;
  visit(node, depth);
  for (const c of node.children ?? []) walkRaw(c, visit, depth + 1);
}
