/**
 * Unit tests for `figmingo-mcp doctor` (src/doctor.ts) — hermetic via injected
 * fetch / chromium probe / port probe / tmp home dirs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkNode,
  checkToken,
  checkPlugin,
  checkClientEntry,
  clientConfigTargets,
  runDoctorChecks,
  formatDoctorReport,
} from '../../src/doctor';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-doctor-'));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('doctor checks', () => {
  it('checkNode passes on the current runtime', () => {
    expect(checkNode().ok).toBe(true);
  });

  it('checkToken: missing token fails with a fix hint', async () => {
    const check = await checkToken({} as NodeJS.ProcessEnv, fetch, tmpHome(), 'linux');
    expect(check.ok).toBe(false);
    expect(check.fix).toContain('install.sh');
  });

  it('checkToken: valid token → ok with a masked handle', async () => {
    const fetchImpl = (async () => jsonResponse({ handle: 'administer', email: 'admin@example.com' })) as typeof fetch;
    const check = await checkToken({ FIGMA_API_KEY: 'pat' } as NodeJS.ProcessEnv, fetchImpl);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('ad***');
    expect(check.detail).not.toContain('administer');
  });

  it('checkToken: 401 → fail; network error → fail', async () => {
    const unauthorized = (async () => jsonResponse({ err: 'bad token' }, 403)) as typeof fetch;
    const c1 = await checkToken({ FIGMA_API_KEY: 'bad' } as NodeJS.ProcessEnv, unauthorized);
    expect(c1.ok).toBe(false);
    expect(c1.detail).toContain('403');
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const c2 = await checkToken({ FIGMA_API_KEY: 'pat' } as NodeJS.ProcessEnv, boom);
    expect(c2.ok).toBe(false);
    expect(c2.detail).toContain('ECONNREFUSED');
  });

  it('checkPlugin: missing files fail; matching hash passes; drift detected', async () => {
    const home = tmpHome();
    const src = tmpHome();
    fs.writeFileSync(path.join(src, 'code.js'), 'bundled-code-v1');

    // nothing installed
    let [files, drift] = checkPlugin(home, src);
    expect(files.ok).toBe(false);
    expect(files.detail).toContain('manifest.json');
    expect(files.detail).toContain('ui.html');
    expect(drift.ok).toBe(false);

    // install all three files, in sync
    const dir = path.join(home, '.figmingo', 'plugin');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['manifest.json', 'ui.html']) fs.writeFileSync(path.join(dir, f), f);
    fs.writeFileSync(path.join(dir, 'code.js'), 'bundled-code-v1');
    [files, drift] = checkPlugin(home, src);
    expect(files.ok).toBe(true);
    expect(drift.ok).toBe(true);

    // drift: installed copy differs from the bundled reference
    fs.writeFileSync(path.join(dir, 'code.js'), 'old-code-v0');
    [, drift] = checkPlugin(home, src);
    expect(drift.ok).toBe(false);
    expect(drift.detail).toContain('drift');
    expect(drift.fix).toContain('install.sh');
  });

  it('checkToken: token discovered from a client config file', async () => {
    const home = tmpHome();
    fs.mkdirSync(path.join(home, '.kimi'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.kimi', 'mcp.json'),
      JSON.stringify({ mcpServers: { figmingo: { command: 'x', env: { FIGMA_API_KEY: 'from-config' } } } }),
    );
    const fetchImpl = (async (url: any, init: any) => {
      expect(init.headers['X-Figma-Token']).toBe('from-config');
      return jsonResponse({ handle: 'configuser' });
    }) as unknown as typeof fetch;
    const check = await checkToken({} as NodeJS.ProcessEnv, fetchImpl, home, 'darwin');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('co***');
    expect(check.detail).toContain('.kimi/mcp.json');
  });

  it('checkClientEntry: json entry / missing entry / invalid json / toml section', () => {
    const home = tmpHome();
    const jsonPath = path.join(home, 'mcp.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ mcpServers: { figmingo: { command: 'figmingo-mcp' } } }));
    const t = { id: 'cursor', label: 'Cursor', path: jsonPath, kind: 'json' as const };
    expect(checkClientEntry(t).ok).toBe(true);

    fs.writeFileSync(jsonPath, JSON.stringify({ mcpServers: { other: {} } }));
    expect(checkClientEntry(t).ok).toBe(false);

    fs.writeFileSync(jsonPath, '{oops');
    const bad = checkClientEntry(t);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('invalid JSON');

    const missing = checkClientEntry({ id: 'kimi', label: 'Kimi', path: path.join(home, 'nope.json'), kind: 'json' });
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('not found');

    const tomlPath = path.join(home, 'config.toml');
    fs.writeFileSync(tomlPath, '[mcp_servers.figmingo]\ncommand = "figmingo-mcp"\n');
    expect(checkClientEntry({ id: 'codex', label: 'Codex', path: tomlPath, kind: 'toml' }).ok).toBe(true);
    fs.writeFileSync(tomlPath, '[model]\nname = "x"\n');
    expect(checkClientEntry({ id: 'codex', label: 'Codex', path: tomlPath, kind: 'toml' }).ok).toBe(false);
  });

  it('clientConfigTargets covers all six clients with platform-specific paths', () => {
    const mac = clientConfigTargets('/home/u', 'darwin');
    expect(mac).toHaveLength(6);
    expect(mac.find((t) => t.id === 'claude-desktop')!.path).toContain('Library/Application Support/Claude');
    const linux = clientConfigTargets('/home/u', 'linux');
    expect(linux.find((t) => t.id === 'vscode')!.path).toBe('/home/u/.config/Code/User/mcp.json');
    expect(linux.find((t) => t.id === 'codex')!.kind).toBe('toml');
  });

  it('runDoctorChecks aggregates; report shows ✓/✗ with fixes; exit semantics', async () => {
    const home = tmpHome();
    const src = tmpHome();
    // make plugin + one client green
    const dir = path.join(home, '.figmingo', 'plugin');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['manifest.json', 'ui.html']) fs.writeFileSync(path.join(dir, f), f);
    fs.writeFileSync(path.join(dir, 'code.js'), 'x');
    fs.writeFileSync(path.join(src, 'code.js'), 'x');
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { figmingo: {} } }));

    const checks = await runDoctorChecks({
      env: {} as NodeJS.ProcessEnv, // token missing → one failure
      homeDir: home,
      pluginSrcDir: src,
      fetchImpl: (async () => jsonResponse({ handle: 'x' })) as typeof fetch,
      chromiumProbe: async () => ({ ok: true, detail: '/fake/chromium' }),
      portProbe: async () => false,
      platform: 'linux',
    });
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(byId.get('node')!.ok).toBe(true);
    expect(byId.get('token')!.ok).toBe(false);
    expect(byId.get('chromium')!.ok).toBe(true);
    expect(byId.get('plugin-files')!.ok).toBe(true);
    expect(byId.get('plugin-drift')!.ok).toBe(true);
    expect(byId.get('client-cursor')!.ok).toBe(true);
    expect(byId.get('client-kimi')!.ok).toBe(false);
    expect(byId.get('bridge-port')!.ok).toBe(true); // informational, never fails

    const report = formatDoctorReport(checks);
    expect(report).toContain('✓ Node.js >= 18');
    expect(report).toContain('✗ Figma token configured');
    expect(report).toContain('↳ fix:');
    expect(report).toMatch(/\d+ check\(s\) need attention/);

    const allGreen = checks.map((c) => ({ ...c, ok: true }));
    expect(formatDoctorReport(allGreen)).toContain('all checks passed');
  });
});
