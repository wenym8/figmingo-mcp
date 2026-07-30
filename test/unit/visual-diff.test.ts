/**
 * Tests for the post-import visual self-check helper (src/replica/visualDiff.ts)
 * used by import_html_replica verifyAfterImport.
 */
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { diffPngBuffers } from '../../src/replica/visualDiff';

function png(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Buffer {
  const p = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      p.data[i] = r;
      p.data[i + 1] = g;
      p.data[i + 2] = b;
      p.data[i + 3] = a;
    }
  }
  return PNG.sync.write(p);
}

describe('diffPngBuffers', () => {
  it('identical images diff to zero', () => {
    const a = png(20, 20, () => [10, 20, 30, 255]);
    const res = diffPngBuffers(a, Buffer.from(a));
    expect(res.diffPixels).toBe(0);
    expect(res.diffRatio).toBe(0);
    expect(res.sizeMismatch).toBe(false);
  });

  it('reports overall and per-band ratios', () => {
    const base = png(10, 10, () => [0, 0, 0, 255]);
    // Bottom half fully white → 50% overall, 100% in the lower band.
    const altered = png(10, 10, (_x, y) => (y >= 5 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const res = diffPngBuffers(base, altered, [
      { name: 'top', y0: 0, y1: 5 },
      { name: 'bottom', y0: 5, y1: 10 },
    ]);
    expect(res.diffRatio).toBeCloseTo(0.5);
    expect(res.bands).toHaveLength(2);
    expect(res.bands[0]).toMatchObject({ name: 'top', diffPixels: 0, ratio: 0 });
    expect(res.bands[1].ratio).toBe(1);
  });

  it('size mismatch compares only the common region and flags it', () => {
    const a = png(10, 10, () => [7, 7, 7, 255]);
    const b = png(20, 20, () => [7, 7, 7, 255]);
    const res = diffPngBuffers(a, b);
    expect(res.sizeMismatch).toBe(true);
    expect(res.width).toBe(10);
    expect(res.diffRatio).toBe(0);
  });

  it('rectangular edge strips localize a right-edge-only error that the global average dilutes', () => {
    // 4px-wide wrong strip on the right edge = 4% of all pixels: passes any
    // sane global gate, yet is a glaring visual defect (the Nectar case).
    const w = 100;
    const strip = 4;
    const base = png(w, w, () => [245, 247, 252, 255]);
    const broken = png(w, w, (x) => (x >= w - strip ? [255, 255, 255, 255] : [245, 247, 252, 255]));
    const res = diffPngBuffers(base, broken, [
      { name: 'LEFT-EDGE', y0: 0, y1: w, x0: 0, x1: 8 },
      { name: 'RIGHT-EDGE', y0: 0, y1: w, x0: w - 8, x1: w },
      { name: 'band', y0: 0, y1: w },
    ]);
    // Global only 4% — the old whole-page gate would call this a pass.
    expect(res.diffRatio).toBeCloseTo(0.04);
    // The right edge strip isolates it: 50% of the strip is wrong.
    const right = res.bands.find((b) => b.name === 'RIGHT-EDGE')!;
    expect(right.ratio).toBeCloseTo(0.5);
    const left = res.bands.find((b) => b.name === 'LEFT-EDGE')!;
    expect(left.ratio).toBe(0);
    // Full-width band dilutes back to 4% — proving x-ranges are required.
    const band = res.bands.find((b) => b.name === 'band')!;
    expect(band.ratio).toBeCloseTo(0.04);
  });
});
