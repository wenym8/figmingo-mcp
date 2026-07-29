/**
 * Replica spec builder: raw Figma subtree → replica-optimized document.
 *
 * The output schema is the contract consumed by `verify_html_parity`:
 * sections/elements with absolute rects (relative to the target node origin),
 * computed typography, hex+alpha colors, gradient data, and an asset manifest.
 */

import { rgbToHex, parseLinearGradient } from './css';

export interface SpecRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpecStyle {
  color?: string; // hex
  colorAlpha?: number;
  backgroundColor?: string; // hex
  backgroundAlpha?: number;
  backgroundImage?: string; // css gradient string or 'none'
  fontFamily?: string;
  fontStyleName?: string; // Figma style name, e.g. 'SemiBold'
  fontWeight?: number;
  fontSize?: number; // px
  letterSpacing?: number | 'normal'; // px
  lineHeight?: number | 'normal'; // px
  textAlign?: string;
  textTransform?: string;
  opacity?: number;
  /** Uniform radius (number) or per-corner [topLeft, topRight, bottomRight, bottomLeft] in px. */
  borderRadius?: number | number[];
  /** CSS box-shadow string (may contain multiple comma-separated shadows, `inset` supported). */
  boxShadow?: string;
  /** Uniform CSS border (extracted from HTML). Non-uniform borders degrade to the max-width side. */
  border?: { color: string; colorAlpha?: number; width: number; style?: 'solid' | 'dashed' | 'dotted' };
}

export type ReplicaElementType = 'text' | 'image' | 'svg' | 'frame' | 'button' | 'input';

export interface ReplicaElement {
  key: string; // path of node ids from section root
  nodeId: string;
  name: string;
  type: ReplicaElementType;
  rect: SpecRect; // absolute, relative to spec canvas origin
  style: SpecStyle;
  text?: string;
  fills?: unknown[];
  assetHint?: string; // 'logo' | 'icon' | 'product' | ... (heuristics, parameterized)
  assetId?: string; // reference into assets manifest
  childrenCount?: number;
  /** Container clips its children (HTML overflow != visible → Figma clipsContent). */
  clipsContent?: boolean;
  /**
   * Text auto-resize hint for create_text (Chromium→Figma metric drift makes
   * fixed-width single-line text wrap). Extractor sets this from the measured
   * line count; importer falls back to a height/fontSize heuristic.
   */
  textAutoResize?: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  /**
   * Nested children for container elements (produced by the HTML extractor).
   * When present on the section root element the importer recurses with
   * parent-relative coordinate conversion; flat specs (no children anywhere)
   * import exactly as before.
   */
  children?: ReplicaElement[];
}

export interface ReplicaSection {
  id: string; // node id
  name: string;
  nodeType: string;
  rect: SpecRect;
  style: SpecStyle;
  elements: ReplicaElement[];
}

export interface ReplicaAsset {
  id: string;
  kind: 'image' | 'svg';
  nodeIds: string[];
  /** Image-fill hash (for kind image). */
  hash?: string;
  /** Download URL (temp Figma URL or empty until downloaded). */
  url?: string;
  /** Original vector source (data:image/svg+xml or file/http URL) when `url` is a rasterized PNG of an SVG. */
  vectorUrl?: string;
  scaleMode?: string;
  fileName: string;
  width?: number;
  height?: number;
}

export interface ReplicaSpec {
  version: 1;
  source: 'figma-rest' | 'html';
  file?: { key?: string; name?: string; lastModified?: string };
  node: { id: string; name: string; type: string };
  canvas: { width: number; height: number; background?: string; backgroundImage?: string };
  sections: ReplicaSection[];
  assets: ReplicaAsset[];
  metadata: { generatedAt: string; options?: Record<string, unknown> };
}

export interface SpecBuildOptions {
  fileKey?: string;
  fileName?: string;
  lastModified?: string;
  /** image-fill hash → URL map (from GET /v1/files/:key/images). */
  imageFills?: Record<string, string>;
  /** nodeId → rendered URL map (from GET /v1/images/:key), for svg/vector assets. */
  renderedNodes?: Record<string, string>;
  /** Sectionizing: 'auto' (children containers) or 'self' (single section). */
  sections?: 'auto' | 'self';
  /** Regex string for logo asset hints. Default /logo/i on node name. */
  logoPattern?: string;
  /** Regex string for icon asset hints. Default /icon|ic[_-]/i on node name. */
  iconPattern?: string;
  /** Include asset manifest entries (urls where available). */
  includeAssets?: boolean;
}

const CONTAINER_TYPES = new Set(['FRAME', 'SECTION', 'INSTANCE', 'COMPONENT']);
const SVG_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON']);

type RawNode = Record<string, any>;

function rectOf(n: RawNode, origin: { x: number; y: number }): SpecRect {
  const b = n.absoluteBoundingBox ?? { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 };
  return {
    x: Math.round(b.x - origin.x),
    y: Math.round(b.y - origin.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  };
}

function visiblePaints(n: RawNode): any[] {
  return Array.isArray(n.fills) ? n.fills.filter((f) => f && f.visible !== false) : [];
}

function firstSolid(n: RawNode): { hex: string; alpha: number } | undefined {
  const p = visiblePaints(n).find((f) => f.type === 'SOLID');
  if (!p) return undefined;
  return { hex: rgbToHex(p.color), alpha: (p.color?.a ?? 1) * (p.opacity ?? 1) };
}

function gradientCss(n: RawNode): string | undefined {
  const p = visiblePaints(n).find((f) => f.type?.startsWith('GRADIENT'));
  if (!p) return undefined;
  const stops = (p.gradientStops ?? [])
    .map((s: any) => `${rgbToHex(s.color)}${s.color?.a !== undefined && s.color.a < 1 ? '' : ''} ${Math.round(s.position * 100)}%`)
    .join(', ');
  let angle = 180;
  const t = p.gradientTransform;
  if (Array.isArray(t) && Array.isArray(t[0])) {
    angle = Math.round(90 - (Math.atan2(t[0][1], t[0][0]) * 180) / Math.PI);
  }
  return `linear-gradient(${angle}deg, ${stops})`;
}

function shadowCss(n: RawNode): string | undefined {
  const e = (n.effects ?? []).find((x: any) => x.type === 'DROP_SHADOW' && x.visible !== false);
  if (!e) return undefined;
  const color = e.color ? `${rgbToHex(e.color)}` : '#000000';
  return `${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${color}`;
}

function textTransformOf(textCase: string | undefined): string {
  switch (textCase) {
    case 'UPPER':
      return 'uppercase';
    case 'LOWER':
      return 'lowercase';
    case 'TITLE':
      return 'capitalize';
    default:
      return 'none';
  }
}

function styleOf(n: RawNode): SpecStyle {
  const style: SpecStyle = {};
  if (n.type === 'TEXT') {
    const solid = firstSolid(n);
    if (solid) {
      style.color = solid.hex;
      style.colorAlpha = solid.alpha;
    }
    const s = n.style ?? {};
    style.fontFamily = s.fontFamily;
    style.fontStyleName = s.fontPostScriptName?.includes('-') ? s.fontPostScriptName.split('-').pop() : s.fontStyle;
    style.fontWeight = s.fontWeight;
    style.fontSize = s.fontSize;
    style.letterSpacing = typeof s.letterSpacing === 'number' ? Math.round(s.letterSpacing * 100) / 100 : 'normal';
    if (typeof s.lineHeightPx === 'number') {
      style.lineHeight = Math.round(s.lineHeightPx * 100) / 100;
    } else if (typeof s.lineHeightPercentFontSize === 'number' && typeof s.fontSize === 'number') {
      style.lineHeight = Math.round(s.fontSize * (s.lineHeightPercentFontSize / 100) * 100) / 100;
    } else {
      style.lineHeight = 'normal';
    }
    style.textAlign = (s.textAlignHorizontal ?? 'LEFT').toLowerCase();
    style.textTransform = textTransformOf(s.textCase);
  } else {
    const solid = firstSolid(n);
    if (solid) {
      style.backgroundColor = solid.hex;
      style.backgroundAlpha = solid.alpha;
    }
    const grad = gradientCss(n);
    style.backgroundImage = grad ?? 'none';
  }
  if (n.opacity !== undefined && n.opacity !== 1) style.opacity = n.opacity;
  const radius = n.cornerRadius ?? n.rectangleCornerRadii;
  if (radius) style.borderRadius = radius;
  const shadow = shadowCss(n);
  if (shadow) style.boxShadow = shadow;
  return style;
}

function imageFillOf(n: RawNode): any | undefined {
  return visiblePaints(n).find((f) => f.type === 'IMAGE');
}

export function buildReplicaSpec(root: RawNode, opts: SpecBuildOptions = {}): ReplicaSpec {
  const rootBox = root.absoluteBoundingBox ?? { x: root.x ?? 0, y: root.y ?? 0, width: root.width ?? 0, height: root.height ?? 0 };
  const origin = { x: rootBox.x, y: rootBox.y };
  const logoRe = new RegExp(opts.logoPattern ?? 'logo', 'i');
  const iconRe = new RegExp(opts.iconPattern ?? '(^|[\\s/_-])(icon|ic)([\\s/_-]|$)|^icon/', 'i');
  const assets = new Map<string, ReplicaAsset>();

  const assetForImageFill = (node: RawNode, fill: any): ReplicaAsset | undefined => {
    if (opts.includeAssets === false) return undefined;
    const hash = fill.imageRef;
    if (!hash) return undefined;
    const id = `img-${String(hash).slice(0, 12)}`;
    const existing = assets.get(id);
    if (existing) {
      if (!existing.nodeIds.includes(node.id)) existing.nodeIds.push(node.id);
      return existing;
    }
    const entry: ReplicaAsset = {
      id,
      kind: 'image',
      nodeIds: [node.id],
      hash,
      url: opts.imageFills?.[hash],
      scaleMode: fill.scaleMode,
      fileName: `${sanitize(node.name)}-${String(hash).slice(0, 8)}.png`,
    };
    assets.set(id, entry);
    return entry;
  };

  const assetForSvg = (node: RawNode): ReplicaAsset | undefined => {
    if (opts.includeAssets === false) return undefined;
    const id = `svg-${node.id.replace(':', '-')}`;
    const existing = assets.get(id);
    if (existing) return existing;
    const b = node.absoluteBoundingBox;
    const entry: ReplicaAsset = {
      id,
      kind: 'svg',
      nodeIds: [node.id],
      url: opts.renderedNodes?.[node.id],
      fileName: `${sanitize(node.name)}.svg`,
      width: b?.width,
      height: b?.height,
    };
    assets.set(id, entry);
    return entry;
  };

  const elementFor = (n: RawNode, key: string): ReplicaElement => {
    const rect = rectOf(n, origin);
    const style = styleOf(n);
    const imgFill = imageFillOf(n);
    const el: ReplicaElement = {
      key,
      nodeId: n.id,
      name: n.name,
      type: 'frame',
      rect,
      style,
    };
    if (n.type === 'TEXT') {
      el.type = 'text';
      el.text = n.characters ?? '';
    } else if (imgFill) {
      el.type = 'image';
      const asset = assetForImageFill(n, imgFill);
      if (asset) el.assetId = asset.id;
      if (logoRe.test(n.name)) el.assetHint = 'logo';
      else if (iconRe.test(n.name)) el.assetHint = 'icon';
    } else if (SVG_TYPES.has(n.type)) {
      el.type = 'svg';
      const asset = assetForSvg(n);
      if (asset) el.assetId = asset.id;
      el.assetHint = 'icon';
    } else if (n.type === 'GROUP' && (n.children ?? []).every((c: RawNode) => SVG_TYPES.has(c.type) || c.type === 'GROUP')) {
      el.type = 'svg';
      const asset = assetForSvg(n);
      if (asset) el.assetId = asset.id;
      el.assetHint = 'icon';
    }
    const kids = (n.children ?? []).filter((c: RawNode) => c.visible !== false);
    if (kids.length) el.childrenCount = kids.length;
    return el;
  };

  const walk = (n: RawNode, parentKey: string, out: ReplicaElement[]) => {
    if (!n || n.visible === false) return;
    const key = parentKey ? `${parentKey}/${n.id}` : n.id;
    out.push(elementFor(n, key));
    // Vector subtrees are leaf assets; don't descend into their path/children internals.
    if (SVG_TYPES.has(n.type)) return;
    for (const c of n.children ?? []) walk(c, key, out);
  };

  const sectionRoots: RawNode[] = pickSections(root, opts.sections ?? 'auto');
  const sections: ReplicaSection[] = [];
  for (const s of sectionRoots) {
    if (s.visible === false) continue;
    const elements: ReplicaElement[] = [];
    walk(s, '', elements);
    sections.push({
      id: s.id,
      name: s.name,
      nodeType: s.type,
      rect: rectOf(s, origin),
      style: styleOf(s),
      elements,
    });
  }

  const bg = firstSolid(root);
  return {
    version: 1,
    source: 'figma-rest',
    file: { key: opts.fileKey, name: opts.fileName ?? root.name, lastModified: opts.lastModified },
    node: { id: root.id, name: root.name, type: root.type },
    canvas: {
      width: Math.round(rootBox.width),
      height: Math.round(rootBox.height),
      background: bg?.hex,
    },
    sections,
    assets: opts.includeAssets === false ? [] : Array.from(assets.values()),
    metadata: { generatedAt: new Date().toISOString(), options: { sections: opts.sections ?? 'auto' } },
  };
}

function pickSections(root: RawNode, mode: 'auto' | 'self'): RawNode[] {
  const kids = (root.children ?? []).filter((c: RawNode) => c.visible !== false);
  if (mode === 'self') return [root];
  if (!kids.length) return [root];
  if (root.type === 'CANVAS' || root.type === 'DOCUMENT') return kids;
  // A node whose children are all loose leaves (no container frames) is itself one section.
  const hasContainer = kids.some((c: RawNode) => CONTAINER_TYPES.has(c.type));
  if (!hasContainer) return [root];
  // Otherwise every top-level child becomes a section (predictable, tree-faithful).
  return kids;
}

function sanitize(name: string): string {
  return String(name).replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'asset';
}

export { parseLinearGradient };
