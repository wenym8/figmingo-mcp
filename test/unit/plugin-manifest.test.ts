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

describe('plugin architecture: WebSocket lives in the UI iframe', () => {
  const pluginDir = path.join(__dirname, '../../plugin');
  const codeSrc = fs.readFileSync(path.join(pluginDir, 'code.ts'), 'utf8');
  const uiPath = path.join(pluginDir, 'ui.html');

  it('manifest declares a ui entry and the file exists', () => {
    expect(manifest.ui).toBe('ui.html');
    expect(fs.existsSync(uiPath)).toBe(true);
  });

  it('code.js sandbox never touches WebSocket (unavailable in Figma sandbox)', () => {
    // strip comments first: the architecture note in the header comment
    // legitimately mentions `new WebSocket()` as unavailable.
    const bare = codeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    expect(bare).not.toContain('WebSocket');
    // sandbox half: shows the UI panel and relays envelopes via onmessage
    expect(codeSrc).toContain('figma.showUI(__html__');
    expect(codeSrc).toContain('figma.ui.onmessage');
    expect(codeSrc).toContain('figma.ui.postMessage');
  });

  it('ui.html owns the socket: connect, backoff reconnect, hello, relay', () => {
    const ui = fs.readFileSync(uiPath, 'utf8');
    expect(ui).toContain('new WebSocket');
    expect(ui).toContain('ws://127.0.0.1:39220');
    // exponential backoff capped at 15s
    expect(ui).toContain('15000');
    // hello handshake with init data provided by code.js
    expect(ui).toContain("'hello'");
    expect(ui).toContain('sessionId');
    // postMessage bridge both directions
    expect(ui).toContain('pluginMessage');
    expect(ui).toContain("toCode({ type: 'ui-ready' })");
    expect(ui).toContain("'command'");
    expect(ui).toContain("'command-result'");
    // visible status panel (users must see it is not stuck)
    expect(ui).toContain('commands executed');
    expect(ui).toContain('connecting');
  });
});
