/**
 * Lightweight PNG diffing for post-import self-checks (verifyAfterImport).
 * Reuses pixelmatch/pngjs — same visual-diff primitives as verify.ts, but
 * decoupled from the parity gates (which stay untouched).
 *
 * Threshold note: pixelmatch's common default 0.1 is blind to subtle but
 * visually obvious background shifts — e.g. page-gray #f5f7fc vs white
 * (the Nectar cart right-edge bug) diffs ZERO at 0.1 and 0.05. 0.03 still
 * ignores antialiasing (AA pixels are detected and skipped) while catching
 * that class of error.
 */

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface DiffBand {
  name: string;
  /** Vertical range in pixels (clamped to the compared height). */
  y0: number;
  y1: number;
  /** Optional horizontal range (clamped); omitted = full width. Edge strips use this. */
  x0?: number;
  x1?: number;
}

export interface BandDiffResult extends DiffBand {
  diffPixels: number;
  totalPixels: number;
  ratio: number;
}

export interface PngDiffResult {
  /** Compared region (min of the two images per axis). */
  width: number;
  height: number;
  /** Source image sizes differed; only the common region was compared. */
  sizeMismatch: boolean;
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  bands: BandDiffResult[];
}

function crop(png: PNG, width: number, height: number, y0 = 0, x0 = 0): PNG {
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, x0, y0, width, height, 0, 0);
  return out;
}

function countDiff(a: PNG, b: PNG): number {
  return pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.03 });
}

/**
 * Pixel-diff two PNG buffers over their common region, overall and per band
 * (horizontal slices, or rectangular strips when the band carries x0/x1).
 * Throws on undecodable PNGs.
 */
export function diffPngBuffers(expected: Buffer, actual: Buffer, bands: DiffBand[] = []): PngDiffResult {
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(actual);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (width < 1 || height < 1) throw new Error(`cannot diff ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  const ca = crop(a, width, height);
  const cb = crop(b, width, height);
  const diffPixels = countDiff(ca, cb);
  const totalPixels = width * height;
  const bandResults: BandDiffResult[] = bands.map((band) => {
    const y0 = Math.max(0, Math.min(height, Math.round(band.y0)));
    const y1 = Math.max(y0, Math.min(height, Math.round(band.y1)));
    const x0 = Math.max(0, Math.min(width, Math.round(band.x0 ?? 0)));
    const x1 = Math.max(x0, Math.min(width, Math.round(band.x1 ?? width)));
    const h = y1 - y0;
    const w = x1 - x0;
    if (h < 1 || w < 1) return { ...band, y0, y1, x0, x1, diffPixels: 0, totalPixels: 0, ratio: 0 };
    const d = countDiff(crop(ca, w, h, y0, x0), crop(cb, w, h, y0, x0));
    return { ...band, y0, y1, x0, x1, diffPixels: d, totalPixels: w * h, ratio: d / (w * h) };
  });
  return {
    width,
    height,
    sizeMismatch,
    diffPixels,
    totalPixels,
    diffRatio: diffPixels / totalPixels,
    bands: bandResults,
  };
}
