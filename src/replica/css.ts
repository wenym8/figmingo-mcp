/**
 * CSS ↔ Figma conversion utilities.
 * Ported from the internal figwright-lib.mjs, with brand-specific coupling removed
 * (font aliases / weight fallbacks are now parameters instead of hard-coded
 * Open Sans / Montserrat rules).
 */

export interface CssColor {
  r: number; // 0..1
  g: number;
  b: number;
  a: number; // 0..1
  hex?: string;
}

export function hexToRgb(hexStr: string): { r: number; g: number; b: number } {
  const n = hexStr.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

/** Parse '#rrggbb', '#rgb', 'rgb(...)', 'rgba(...)'. Returns null for transparent/unknown. */
export function parseCssColor(str: string | undefined | null): CssColor | null {
  if (!str) return null;
  const s = str.trim();
  if (s === 'transparent' || s === 'rgba(0, 0, 0, 0)' || s === 'none') return null;
  if (s.startsWith('#')) {
    return { ...hexToRgb(s), a: 1, hex: normalizeHex(s) };
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  const r = +m[1];
  const g = +m[2];
  const b = +m[3];
  return {
    r: r / 255,
    g: g / 255,
    b: b / 255,
    a,
    hex: `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`,
  };
}

export function normalizeHex(s: string): string {
  const n = s.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  return `#${full.toLowerCase().padEnd(6, '0').slice(0, 6)}`;
}

export function rgbToHex(c: { r: number; g: number; b: number } | undefined | null): string {
  if (!c) return '#000000';
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Figma SOLID paint from a parsed CSS color. */
export function solidPaint(color: CssColor, opacity = 1) {
  const a = color.a !== undefined ? color.a * opacity : opacity;
  return { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: a };
}

/**
 * CSS linear-gradient angle → Figma gradient transform.
 * CSS: 0deg points up (bottom→top), clockwise. Figma: 0deg = left→right, CCW.
 */
export function linearGradientPaint(stops: Array<{ position: number; color: CssColor }>, cssAngleDeg = 180) {
  const figmaAngleDeg = 90 - cssAngleDeg;
  const rad = (figmaAngleDeg * Math.PI) / 180;
  const transform = [
    [Math.cos(rad), Math.sin(rad), 0],
    [-Math.sin(rad), Math.cos(rad), 0],
  ];
  return {
    type: 'GRADIENT_LINEAR',
    gradientStops: stops.map((s) => ({
      position: s.position,
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a ?? 1 },
    })),
    gradientTransform: transform,
  };
}

/** Parse a CSS linear-gradient(...) string into stops + angle (best effort). */
export function parseLinearGradient(str: string): { angle: number; stops: Array<{ position: number; color: CssColor }> } | null {
  if (!str || !str.includes('linear-gradient')) return null;
  const inner = str.slice(str.indexOf('(') + 1, str.lastIndexOf(')'));
  const parts = splitTopLevel(inner);
  let angle = 180;
  let stopParts = parts;
  const first = parts[0]?.trim();
  const angleMatch = first?.match(/^(-?[\d.]+)deg$/);
  if (angleMatch) {
    angle = parseFloat(angleMatch[1]);
    stopParts = parts.slice(1);
  } else if (first?.startsWith('to ')) {
    const dir = first.slice(3).trim();
    angle = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }[`to ${dir}` as string] ?? 180;
    stopParts = parts.slice(1);
  }
  const stops: Array<{ position: number; color: CssColor }> = [];
  stopParts.forEach((p, i) => {
    const m = p.trim().match(/^(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*([\d.]+%)?$/);
    if (!m) return;
    const color = parseCssColor(m[1]);
    if (!color) return;
    const position = m[2] ? parseFloat(m[2]) / 100 : stopParts.length > 1 ? i / (stopParts.length - 1) : 0;
    stops.push({ position, color });
  });
  return stops.length ? { angle, stops } : null;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const FONT_WEIGHT_MAP: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

export interface FontName {
  family: string;
  style: string;
}

export interface FontMapOptions {
  /** CSS family → Figma family aliases, e.g. { Arial: 'Open Sans' }. */
  familyAliases?: Record<string, string>;
  /** Style overrides per family, e.g. { 'Open Sans': { Medium: 'SemiBold' } }. */
  styleOverrides?: Record<string, Record<string, string>>;
  defaultFamily?: string;
}

/** CSS font-family/weight → Figma FontName. */
export function fontFromStyle(
  style: { fontFamily?: string; fontWeight?: string | number },
  opts: FontMapOptions = {},
): FontName {
  let family = (style.fontFamily || opts.defaultFamily || 'Inter').replace(/['"]/g, '').split(',')[0].trim();
  if (opts.familyAliases?.[family]) family = opts.familyAliases[family];
  const weight = typeof style.fontWeight === 'string' ? parseInt(style.fontWeight, 10) : style.fontWeight;
  let fontStyle = FONT_WEIGHT_MAP[weight || 400] || 'Regular';
  const override = opts.styleOverrides?.[family]?.[fontStyle];
  if (override) fontStyle = override;
  return { family, style: fontStyle };
}

export function letterSpacingFromStyle(style: { letterSpacing?: string }): { unit: 'PIXELS'; value: number } | undefined {
  const ls = style.letterSpacing;
  if (!ls || ls === 'normal') return undefined;
  const px = parseFloat(ls);
  if (Number.isNaN(px)) return undefined;
  return { unit: 'PIXELS', value: px };
}

export function lineHeightFromStyle(style: { lineHeight?: string | number }): { unit: 'PIXELS'; value: number } | undefined {
  const lh = style.lineHeight;
  if (lh === undefined || lh === null || lh === 'normal') return undefined;
  const px = typeof lh === 'number' ? lh : parseFloat(lh);
  if (Number.isNaN(px)) return undefined;
  return { unit: 'PIXELS', value: px };
}

export function textCaseFromStyle(style: { textTransform?: string }): 'UPPER' | 'LOWER' | 'TITLE' | undefined {
  const t = style.textTransform;
  if (!t || t === 'none') return undefined;
  if (t === 'uppercase') return 'UPPER';
  if (t === 'lowercase') return 'LOWER';
  if (t === 'capitalize') return 'TITLE';
  return undefined;
}

export function textAlignFromStyle(style: { textAlign?: string }): 'LEFT' | 'RIGHT' | 'CENTER' | 'JUSTIFIED' | undefined {
  const map: Record<string, 'LEFT' | 'RIGHT' | 'CENTER' | 'JUSTIFIED'> = {
    left: 'LEFT',
    right: 'RIGHT',
    center: 'CENTER',
    start: 'LEFT',
    end: 'RIGHT',
    justify: 'JUSTIFIED',
  };
  return style.textAlign ? map[style.textAlign] : undefined;
}
