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
});
