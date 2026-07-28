/**
 * Three-gate parity verifier: Figma replica spec vs rendered HTML extraction.
 *
 * Ported from the internal parity-lib.mjs. All tolerances preserved:
 *   POS_TOL = 4, COLOR_TOL = 2/255, FONT_SIZE_TOL = 1, LS_TOL = 0.5,
 *   LH_TOL = 2, VISUAL_MAX_RATIO = 0.01 (pixel diff ratio, 2px crop tolerance).
 * Brand-specific coupling (textual leaf classes, background classes, section
 * key mapping, hard-coded logo/asset/icon counts) is parameterized via
 * VerifyOptions and/or spec.metadata.
 */

import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { parseCssColor, rgbToHex, fontFromStyle, type FontMapOptions } from './css';
import type { ReplicaSpec, ReplicaSection, ReplicaElement } from './spec';
import type { HtmlLayoutSpec, HtmlSection, HtmlElementEntry } from './render';

export const POS_TOL = 4;
export const COLOR_TOL = 2 / 255;
export const FONT_SIZE_TOL = 1;
export const LS_TOL = 0.5;
export const LH_TOL = 2;
export const VISUAL_MAX_RATIO = 0.01;
export const VISUAL_CROP_TOL = 2;

export interface VerifyOptions {
  positionTolerance?: number;
  colorTolerance?: number;
  fontSizeTolerance?: number;
  letterSpacingTolerance?: number;
  lineHeightTolerance?: number;
  visualMaxRatio?: number;
  /** Spec section ids/names to skip (e.g. floating widgets). */
  skipSections?: string[];
  /** specSectionId → htmlSectionId override map. */
  sectionMap?: Record<string, string>;
  /** Expected matched-asset counts, e.g. { logos: 2, assets: 12, minIcons: 17 }. */
  expectedCounts?: { logos?: number; assets?: number; minIcons?: number };
  /** Extra rect slack per assetHint, e.g. { product: 20 }. */
  looseRectHints?: Record<string, number>;
  /** Font family aliases / style overrides for cross-name comparison. */
  fontMap?: FontMapOptions;
}

export function normalizeText(s: string | undefined | null): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

interface Vec {
  x: number;
  y: number;
}
interface Rect extends Vec {
  width: number;
  height: number;
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function rectClose(a: Rect, b: Rect, tol = POS_TOL): boolean {
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}

function relRect(rect: Rect, section: Rect): Rect {
  return { x: rect.x - section.x, y: rect.y - section.y, width: rect.width, height: rect.height };
}

function hexAlphaOf(el: ReplicaElement, field: 'text' | 'background'): { hex?: string; alpha?: number } {
  const s = el.style;
  if (field === 'text') return { hex: s.color, alpha: s.colorAlpha };
  return { hex: s.backgroundColor, alpha: s.backgroundAlpha };
}

function colorClose(expectedHex: string | undefined, expectedAlpha: number | undefined, actualCss: string | undefined, tol = COLOR_TOL): boolean {
  const actual = parseCssColor(actualCss);
  if (!expectedHex) return !actual;
  if (!actual) return false;
  const e = parseCssColor(expectedHex);
  if (!e) return false;
  const ea = expectedAlpha ?? 1;
  return Math.abs(e.r - actual.r) <= tol && Math.abs(e.g - actual.g) <= tol && Math.abs(e.b - actual.b) <= tol && Math.abs(ea - actual.a) <= 0.05;
}

interface SpecPlaceable {
  el: ReplicaElement;
  rel: Rect;
  placeType: 'text' | 'image' | 'svg' | 'background' | 'button' | 'input';
}

function isBackgroundFrame(el: ReplicaElement): boolean {
  if (el.type !== 'frame') return false;
  const s = el.style;
  if (s.backgroundColor && (s.backgroundAlpha ?? 1) > 0.02) return true;
  if (s.backgroundImage && s.backgroundImage !== 'none' && s.backgroundImage.includes('gradient')) return true;
  return false;
}

function isSectionRootEl(el: ReplicaElement, section: ReplicaSection): boolean {
  const r = el.rect;
  const sr = section.rect;
  return r.x === sr.x && r.y === sr.y && r.width === sr.width && r.height === sr.height;
}

/** Elements worth verifying, in placement order (backgrounds first, texts last is fine). */
export function getPlaceables(section: ReplicaSection): SpecPlaceable[] {
  const out: SpecPlaceable[] = [];
  for (const el of section.elements) {
    const rel = relRect(el.rect, section.rect);
    if (el.type === 'text' && normalizeText(el.text)) {
      out.push({ el, rel, placeType: 'text' });
    } else if (el.type === 'image') {
      out.push({ el, rel, placeType: 'image' });
    } else if (el.type === 'svg') {
      out.push({ el, rel, placeType: 'svg' });
    } else if (isBackgroundFrame(el) && !isSectionRootEl(el, section)) {
      out.push({ el, rel, placeType: 'background' });
    }
  }
  return out;
}

interface HtmlCandidate {
  el: HtmlElementEntry;
  rel: Rect;
}

function htmlCandidates(section: HtmlSection | undefined, type: string): HtmlCandidate[] {
  if (!section) return [];
  return section.elements
    .filter((e) => e.type === type)
    .map((e) => ({ el: e, rel: relRect(e.rect, section.rect) }));
}

function findBestText(specEl: SpecPlaceable, candidates: HtmlCandidate[], used: Set<string>): HtmlCandidate | undefined {
  const want = normalizeText(specEl.el.text);
  const exact = candidates.filter((c) => !used.has(c.el.key) && normalizeText(c.el.text) === want);
  const pool = exact.length
    ? exact
    : candidates.filter((c) => !used.has(c.el.key) && want.length > 0 && normalizeText(c.el.text).includes(want.slice(0, Math.min(20, want.length))));
  return pool.sort((a, b) => dist(specEl.rel, a.rel) - dist(specEl.rel, b.rel))[0];
}

function findNearestRect(specEl: SpecPlaceable, candidates: HtmlCandidate[], used: Set<string>, rectTol: number, distTol: number): HtmlCandidate | undefined {
  return candidates
    .filter((c) => !used.has(c.el.key))
    .sort((a, b) => dist(specEl.rel, a.rel) - dist(specEl.rel, b.rel))
    .find((c) => rectClose(specEl.rel, c.rel, rectTol) || dist(specEl.rel, c.rel) < distTol);
}

export interface MatchPair {
  spec: SpecPlaceable;
  html?: HtmlCandidate;
}

export function matchSection(specSection: ReplicaSection, htmlSection: HtmlSection | undefined, opts: VerifyOptions = {}): MatchPair[] {
  const placeables = getPlaceables(specSection);
  const texts = htmlCandidates(htmlSection, 'text');
  const images = htmlCandidates(htmlSection, 'image');
  const svgs = htmlCandidates(htmlSection, 'svg');
  const frames = htmlCandidates(htmlSection, 'frame').concat(htmlCandidates(htmlSection, 'button'), htmlCandidates(htmlSection, 'input'));
  const used = new Set<string>();
  const pairs: MatchPair[] = [];
  const posTol = opts.positionTolerance ?? POS_TOL;

  for (const p of placeables) {
    let hit: HtmlCandidate | undefined;
    const loose = p.el.assetHint ? opts.looseRectHints?.[p.el.assetHint] ?? 0 : 0;
    if (p.placeType === 'text') {
      hit = findBestText(p, texts, used);
    } else if (p.placeType === 'image') {
      hit = findNearestRect(p, images, used, posTol + 4 + loose, 20 + loose);
    } else if (p.placeType === 'svg') {
      hit = svgs
        .filter((c) => !used.has(c.el.key))
        .sort((a, b) => dist(p.rel, a.rel) - dist(p.rel, b.rel))
        .find((c) => dist(p.rel, c.rel) < 30);
    } else {
      hit = findNearestRect(p, frames, used, posTol + 8, 24);
    }
    if (hit) used.add(hit.el.key);
    pairs.push({ spec: p, html: hit });
  }
  return pairs;
}

// ---- per-element verifications ----

export function verifyCopy(specEl: SpecPlaceable, htmlEl?: HtmlCandidate) {
  if (!htmlEl) return { ok: false as const, reason: 'missing' };
  const a = normalizeText(specEl.el.text);
  const b = normalizeText(htmlEl.el.text);
  if (a === b) return { ok: true as const };
  if (b.includes(a) || a.includes(b)) return { ok: true as const };
  return { ok: false as const, reason: 'mismatch', expected: a, actual: b };
}

export function verifyFont(specEl: SpecPlaceable, htmlEl: HtmlCandidate | undefined, opts: VerifyOptions = {}) {
  if (!htmlEl || htmlEl.el.type !== 'text') return { ok: false as const, reason: 'not_text' };
  const fsTol = opts.fontSizeTolerance ?? FONT_SIZE_TOL;
  const lsTol = opts.letterSpacingTolerance ?? LS_TOL;
  const lhTol = opts.lineHeightTolerance ?? LH_TOL;
  const failures: Array<{ field: string; expected: unknown; actual: unknown }> = [];
  const s = specEl.el.style;
  const hs = htmlEl.el.style;
  const actualFont = fontFromStyle({ fontFamily: hs.fontFamily, fontWeight: hs.fontWeight }, opts.fontMap);
  const expectedFamily = s.fontFamily;
  if (expectedFamily && actualFont.family.toLowerCase() !== expectedFamily.toLowerCase()) {
    failures.push({ field: 'family', expected: expectedFamily, actual: actualFont.family });
  }
  if (s.fontStyleName && actualFont.style && s.fontStyleName.toLowerCase() !== actualFont.style.toLowerCase()) {
    failures.push({ field: 'style', expected: s.fontStyleName, actual: actualFont.style });
  }
  if (typeof s.fontSize === 'number' && typeof hs.fontSize === 'number' && Math.abs(hs.fontSize - s.fontSize) > fsTol) {
    failures.push({ field: 'fontSize', expected: s.fontSize, actual: hs.fontSize });
  }
  if (typeof s.letterSpacing === 'number' && hs.letterSpacing && hs.letterSpacing !== 'normal') {
    const actualLs = parseFloat(hs.letterSpacing);
    if (!Number.isNaN(actualLs) && Math.abs(actualLs - s.letterSpacing) > lsTol) {
      failures.push({ field: 'letterSpacing', expected: s.letterSpacing, actual: actualLs });
    }
  }
  if (typeof s.lineHeight === 'number' && hs.lineHeight && hs.lineHeight !== 'normal') {
    const actualLh = parseFloat(hs.lineHeight);
    if (!Number.isNaN(actualLh) && Math.abs(actualLh - s.lineHeight) > lhTol) {
      failures.push({ field: 'lineHeight', expected: s.lineHeight, actual: actualLh });
    }
  }
  const expectedTransform = s.textTransform && s.textTransform !== 'none' ? s.textTransform : undefined;
  const actualTransform = hs.textTransform && hs.textTransform !== 'none' ? hs.textTransform : undefined;
  if (expectedTransform !== actualTransform) {
    failures.push({ field: 'textTransform', expected: expectedTransform ?? 'none', actual: actualTransform ?? 'none' });
  }
  return failures.length ? { ok: false as const, failures } : { ok: true as const };
}

export function verifyColor(specEl: SpecPlaceable, htmlEl: HtmlCandidate | undefined, opts: VerifyOptions = {}) {
  if (!htmlEl) return { ok: false as const, reason: 'missing' };
  const tol = opts.colorTolerance ?? COLOR_TOL;
  if (specEl.placeType === 'text') {
    const { hex, alpha } = hexAlphaOf(specEl.el, 'text');
    if (!colorClose(hex, alpha, htmlEl.el.style.color, tol)) {
      return { ok: false as const, expected: hex, actual: htmlEl.el.style.color };
    }
    return { ok: true as const };
  }
  if (specEl.placeType === 'background') {
    const bgImg = specEl.el.style.backgroundImage;
    if (bgImg && bgImg !== 'none' && bgImg.includes('gradient')) return { ok: true as const, skipped: 'gradient' };
    const { hex, alpha } = hexAlphaOf(specEl.el, 'background');
    if (hex && !colorClose(hex, alpha, htmlEl.el.style.backgroundColor, tol)) {
      return { ok: false as const, expected: hex, actual: htmlEl.el.style.backgroundColor };
    }
  }
  return { ok: true as const, skipped: specEl.placeType };
}

export function verifyImage(specEl: SpecPlaceable, htmlEl: HtmlCandidate | undefined, opts: VerifyOptions = {}) {
  if (!htmlEl) return { ok: false as const, reason: 'missing' };
  const loose = specEl.el.assetHint ? opts.looseRectHints?.[specEl.el.assetHint] ?? 0 : 0;
  const tol = (opts.positionTolerance ?? POS_TOL) + loose;
  if (!rectClose(specEl.rel, htmlEl.rel, tol)) {
    return {
      ok: false as const,
      reason: 'size',
      expected: specEl.rel,
      actual: htmlEl.rel,
    };
  }
  return { ok: true as const };
}

// ---- gates ----

interface GateFlag {
  passed: boolean;
  [k: string]: unknown;
}

export function runContentGate(spec: ReplicaSpec, html: HtmlLayoutSpec, opts: VerifyOptions = {}) {
  const copy: GateFlag & { missing: string[]; mismatch: unknown[] } = { passed: true, missing: [], mismatch: [] };
  const font: GateFlag & { failures: unknown[] } = { passed: true, failures: [] };
  const color: GateFlag & { failures: unknown[] } = { passed: true, failures: [] };
  const image: GateFlag & { failures: unknown[]; logos: number; assets: number; icons: number } = {
    passed: true,
    failures: [],
    logos: 0,
    assets: 0,
    icons: 0,
  };
  const skip = new Set(opts.skipSections ?? []);

  for (const section of spec.sections) {
    if (skip.has(section.id) || skip.has(section.name)) continue;
    const htmlSection = findHtmlSection(spec, html, section, opts);
    const pairs = matchSection(section, htmlSection, opts);
    for (const { spec: p, html: h } of pairs) {
      if (p.placeType === 'text') {
        const c = verifyCopy(p, h);
        if (!h) {
          copy.passed = false;
          copy.missing.push(p.el.key);
          continue;
        }
        if (!c.ok) {
          copy.passed = false;
          copy.mismatch.push({ key: p.el.key, ...c });
        }
        const f = verifyFont(p, h, opts);
        if (!f.ok) {
          font.passed = false;
          font.failures.push({ key: p.el.key, ...f });
        }
        const col = verifyColor(p, h, opts);
        if (!col.ok) {
          color.passed = false;
          color.failures.push({ key: p.el.key, ...col });
        }
      } else if (p.placeType === 'image') {
        const im = verifyImage(p, h, opts);
        if (!im.ok) {
          image.passed = false;
          image.failures.push({ key: p.el.key, ...im });
        } else if (p.el.assetHint === 'logo') image.logos++;
        else image.assets++;
      } else if (p.placeType === 'svg') {
        if (!h) {
          image.passed = false;
          image.failures.push({ key: p.el.key, reason: 'missing' });
        } else image.icons++;
      } else if (p.placeType === 'background') {
        const col = verifyColor(p, h, opts);
        if (!col.ok) {
          color.passed = false;
          color.failures.push({ key: p.el.key, ...col });
        }
      }
    }
  }

  const counts = opts.expectedCounts;
  const countFailures: string[] = [];
  if (counts) {
    if (counts.logos !== undefined && image.logos !== counts.logos) countFailures.push(`logos ${image.logos} != ${counts.logos}`);
    if (counts.assets !== undefined && image.assets !== counts.assets) countFailures.push(`assets ${image.assets} != ${counts.assets}`);
    if (counts.minIcons !== undefined && image.icons < counts.minIcons) countFailures.push(`icons ${image.icons} < ${counts.minIcons}`);
  }
  if (countFailures.length) image.passed = false;

  return { passed: copy.passed && font.passed && color.passed && image.passed, copy, font, color, image, countFailures };
}

function findHtmlSection(spec: ReplicaSpec, html: HtmlLayoutSpec, section: ReplicaSection, opts: VerifyOptions): HtmlSection | undefined {
  const mapped = opts.sectionMap?.[section.id] ?? opts.sectionMap?.[section.name];
  if (mapped) return html.sections.find((s) => s.id === mapped);
  const skip = new Set(opts.skipSections ?? []);
  const specIdx = spec.sections.filter((s) => !skip.has(s.id) && !skip.has(s.name)).indexOf(section);
  const byName = html.sections.find(
    (s) => s.id.toLowerCase() === section.name.toLowerCase() || s.id.toLowerCase() === section.id.toLowerCase(),
  );
  if (byName) return byName;
  return html.sections[specIdx];
}

export function runStructuralGate(spec: ReplicaSpec, html: HtmlLayoutSpec, opts: VerifyOptions = {}) {
  const failures: unknown[] = [];
  let total = 0;
  let matched = 0;
  const posTol = opts.positionTolerance ?? POS_TOL;
  const skip = new Set(opts.skipSections ?? []);

  for (const section of spec.sections) {
    if (skip.has(section.id) || skip.has(section.name)) continue;
    const htmlSection = findHtmlSection(spec, html, section, opts);
    if (!htmlSection) {
      failures.push({ section: section.id, reason: 'missing_section' });
      continue;
    }
    const yDelta = Math.abs(htmlSection.rect.y - section.rect.y);
    const hDelta = Math.abs(htmlSection.rect.height - section.rect.height);
    if (yDelta > posTol || hDelta > posTol) {
      failures.push({
        section: section.id,
        reason: 'section_bounds',
        yDelta,
        hDelta,
        expected: section.rect,
        actual: { y: htmlSection.rect.y, height: htmlSection.rect.height },
      });
    }
    const pairs = matchSection(section, htmlSection, opts);
    for (const { spec: p, html: h } of pairs) {
      total++;
      if (!h) {
        failures.push({ key: p.el.key, reason: 'missing', placeType: p.placeType });
        continue;
      }
      const loose = p.el.assetHint ? opts.looseRectHints?.[p.el.assetHint] ?? 0 : 0;
      if (!rectClose(p.rel, h.rel, posTol + loose)) {
        failures.push({ key: p.el.key, reason: 'position', expected: p.rel, actual: h.rel });
        continue;
      }
      matched++;
    }
  }
  return { passed: failures.length === 0, total, matched, failures };
}

export interface VisualComparison {
  name: string;
  passed: boolean;
  diffRatio?: number;
  diffPixels?: number;
  totalPixels?: number;
  diffPath?: string;
  error?: string;
}

export interface VisualGateResult {
  passed: boolean;
  skipped?: boolean;
  comparisons: VisualComparison[];
}

/** Pixel diff two PNG buffers with a 2px crop tolerance. */
export function diffImages(bufA: Buffer, bufB: Buffer, outPath?: string, maxRatio = VISUAL_MAX_RATIO): VisualComparison & { diffRatio: number } {
  const r = comparePngBuffers(bufA, bufB, { outPath, maxRatio });
  return {
    name: '',
    passed: r.passed,
    diffRatio: r.diffRatio,
    diffPixels: r.diffPixels,
    totalPixels: r.totalPixels,
    diffPath: r.diffImagePath,
    error: r.error,
  };
}

export interface CompareBand {
  index: number;
  yStart: number;
  yEnd: number; // exclusive
  diffRatio: number;
  diffPixels: number;
}

export interface ComparePngOptions {
  /** pixelmatch color-delta threshold (default 0.1). */
  threshold?: number;
  /** Pass line for diffRatio (default VISUAL_MAX_RATIO). */
  maxRatio?: number;
  /** Write the diff PNG here. */
  outPath?: string;
  /** Number of horizontal bands for diff localization; 0/undefined = off. */
  bands?: number;
}

export interface ComparePngResult {
  passed: boolean;
  diffRatio: number;
  diffPixels: number;
  totalPixels: number;
  antiAliasPixels: number;
  size: { render: [number, number]; reference: [number, number] };
  bands?: CompareBand[];
  diffImagePath?: string;
  error?: string;
}

/**
 * Core PNG comparison: pixelmatch (threshold configurable), 2px crop
 * tolerance, anti-alias accounting, and per-band diff localization.
 * First buffer = render, second = reference.
 */
export function comparePngBuffers(renderBuf: Buffer, referenceBuf: Buffer, opts: ComparePngOptions = {}): ComparePngResult {
  const threshold = opts.threshold ?? 0.1;
  const maxRatio = opts.maxRatio ?? VISUAL_MAX_RATIO;
  const a = PNG.sync.read(renderBuf);
  const b = PNG.sync.read(referenceBuf);
  const size = { render: [a.width, a.height] as [number, number], reference: [b.width, b.height] as [number, number] };
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  if (Math.abs(a.width - b.width) > VISUAL_CROP_TOL || Math.abs(a.height - b.height) > VISUAL_CROP_TOL) {
    return {
      passed: false,
      diffRatio: 1,
      diffPixels: 0,
      totalPixels: 0,
      antiAliasPixels: 0,
      size,
      error: `size_mismatch ${a.width}x${a.height} vs ${b.width}x${b.height} (crop tolerance ${VISUAL_CROP_TOL}px)`,
    };
  }
  // Crop both to the common size so pixelmatch never sees mismatched data lengths.
  const crop = (data: Buffer, width: number) => {
    const row = width * 4;
    const cropped = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      data.copy(cropped, y * w * 4, y * row, y * row + w * 4);
    }
    return cropped;
  };
  const da = crop(a.data, a.width);
  const db = crop(b.data, b.width);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(da, db, diff.data, w, h, { threshold });
  // Anti-alias accounting: rerun with includeAA to separate AA pixels from real diffs.
  const diffWithAA = pixelmatch(da, db, null as unknown as Buffer, w, h, { threshold, includeAA: true });
  const antiAliasPixels = Math.max(0, diffWithAA - diffPixels);
  const totalPixels = w * h;
  const ratio = diffPixels / totalPixels;

  let bands: CompareBand[] | undefined;
  const bandCount = opts.bands ?? 0;
  if (bandCount > 0) {
    bands = [];
    const bandH = h / bandCount;
    const counts = new Array<number>(bandCount).fill(0);
    for (let y = 0; y < h; y++) {
      const band = Math.min(bandCount - 1, Math.floor(y / bandH));
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // pixelmatch marks real diffs in diffColor red [255,0,0].
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) counts[band]++;
      }
    }
    for (let idx = 0; idx < bandCount; idx++) {
      const yStart = Math.floor(idx * bandH);
      const yEnd = idx === bandCount - 1 ? h : Math.floor((idx + 1) * bandH);
      const bandPixels = w * (yEnd - yStart);
      bands.push({ index: idx, yStart, yEnd, diffRatio: counts[idx] / bandPixels, diffPixels: counts[idx] });
    }
  }

  if (opts.outPath) {
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    fs.writeFileSync(opts.outPath, PNG.sync.write(diff));
  }
  return {
    passed: ratio <= maxRatio,
    diffRatio: ratio,
    diffPixels,
    totalPixels,
    antiAliasPixels,
    size,
    bands,
    diffImagePath: opts.outPath,
  };
}

export function runVisualGate(
  pairs: Array<{ name: string; expected: Buffer; actual: Buffer }>,
  outDir?: string,
  opts: VerifyOptions = {},
): VisualGateResult {
  const maxRatio = opts.visualMaxRatio ?? VISUAL_MAX_RATIO;
  const comparisons: VisualComparison[] = [];
  for (const p of pairs) {
    const diffPath = outDir ? path.join(outDir, `diff-${p.name}.png`) : undefined;
    try {
      const r = diffImages(p.expected, p.actual, diffPath, maxRatio);
      comparisons.push({ ...r, name: p.name });
    } catch (err) {
      comparisons.push({ name: p.name, passed: false, error: (err as Error).message });
    }
  }
  return { passed: comparisons.every((c) => c.passed), comparisons };
}

export interface ParityReport {
  passed: boolean;
  gates: {
    content: ReturnType<typeof runContentGate>;
    structural: ReturnType<typeof runStructuralGate>;
    visual: VisualGateResult;
  };
  options: Required<Pick<VerifyOptions, never>> & VerifyOptions;
  summary: {
    sections: number;
    elementsChecked: number;
    elementsMatched: number;
    generatedAt: string;
  };
}

export function summarizeReport(
  spec: ReplicaSpec,
  content: ReturnType<typeof runContentGate>,
  structural: ReturnType<typeof runStructuralGate>,
  visual: VisualGateResult,
  opts: VerifyOptions = {},
): ParityReport {
  return {
    passed: content.passed && structural.passed && visual.passed,
    gates: { content, structural, visual },
    options: opts,
    summary: {
      sections: spec.sections.length,
      elementsChecked: structural.total,
      elementsMatched: structural.matched,
      generatedAt: new Date().toISOString(),
    },
  };
}
