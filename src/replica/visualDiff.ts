/**
 * Lightweight PNG diffing for post-import self-checks (verifyAfterImport).
 * Reuses pixelmatch/pngjs — same visual-diff primitives as verify.ts, but
 * decoupled from the parity gates (which stay untouched).
 */

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface DiffBand {
  name: string;
  /** Vertical range in pixels (clamped to the compared height). */
  y0: number;
  y1: number;
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

function crop(png: PNG, width: number, height: number, y0 = 0): PNG {
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, y0, width, height, 0, 0);
  return out;
}

function countDiff(a: PNG, b: PNG): number {
  return pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
}

/**
 * Pixel-diff two PNG buffers over their common region, overall and per
 * vertical band (e.g. one band per spec section). Throws on undecodable PNGs.
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
    const h = y1 - y0;
    if (h < 1) return { ...band, y0, y1, diffPixels: 0, totalPixels: 0, ratio: 0 };
    const d = countDiff(crop(ca, width, h, y0), crop(cb, width, h, y0));
    return { ...band, y0, y1, diffPixels: d, totalPixels: width * h, ratio: d / (width * h) };
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
