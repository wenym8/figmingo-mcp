import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../plugin/manifest.json'), 'utf8'),
);

describe('companion plugin manifest', () => {
  it('has required fields', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.api).toBe('1.0.0');
    expect(manifest.main).toBe('code.js');
    expect(manifest.editorType).toContain('figma');
  });

  it('allowedDomains contains no ws:// or wss:// URLs (Figma rejects them)', () => {
    const domains: string[] = manifest.networkAccess?.allowedDomains ?? [];
    for (const d of domains) {
      expect(d.startsWith('ws://') || d.startsWith('wss://')).toBe(false);
      if (d !== '*') expect(() => new URL(d)).not.toThrow();
    }
  });

  it('main file exists and compiles fresh', () => {
    const codePath = path.join(__dirname, '../../plugin', manifest.main);
    expect(fs.existsSync(codePath)).toBe(true);
    const src = fs.readFileSync(path.join(__dirname, '../../plugin/code.ts'), 'utf8');
    // guard: code.js must be newer than or equal to code.ts edits
    expect(fs.statSync(codePath).mtimeMs).toBeGreaterThanOrEqual(
      fs.statSync(path.join(__dirname, '../../plugin/code.ts')).mtimeMs - 60_000,
    );
    expect(src.length).toBeGreaterThan(1000);
  });
});
