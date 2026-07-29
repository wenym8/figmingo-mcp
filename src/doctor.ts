/**
 * `figmingo-mcp doctor` — environment diagnostics for fresh-machine installs.
 *
 * Checks (each ✓/✗ + fix hint, exit code 0 when all green):
 *  1. Node >= 18
 *  2. Figma token configured (FIGMA_API_KEY / FIGMA_TOKEN) + /v1/me validity
 *  3. Playwright Chromium available (bundled binary or system Chrome channel)
 *  4. Companion plugin files in ~/.figmingo/plugin (manifest/code.js/ui.html)
 *     + drift detection of code.js against the bundled copy
 *  5. figmingo entry present in the six MCP client configs (read-only)
 *  6. Bridge port 39220 listener (is an instance already running?)
 *
 * All probes are injectable so unit tests run hermetically (mock fetch, tmp
 * home dirs, fake fs probes).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  /** Remediation hint shown when ok === false. */
  fix?: string;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Bundled plugin dir used for drift comparison (default: <pkg>/plugin). */
  pluginSrcDir?: string;
  bridgeHost?: string;
  bridgePort?: number;
  fetchImpl?: typeof fetch;
  /** Override the chromium availability probe (tests). */
  chromiumProbe?: () => Promise<{ ok: boolean; detail: string }>;
  /** Override the port-listen probe (tests). */
  portProbe?: (host: string, port: number) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

// --- individual checks (pure-ish, exported for tests) -----------------------

export function checkNode(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= 18;
  return {
    id: 'node',
    label: 'Node.js >= 18',
    ok,
    detail: process.version,
    fix: ok ? undefined : 'Install Node 18+ from https://nodejs.org and re-run.',
  };
}

function maskHandle(raw: string): string {
  if (raw.includes('@')) {
    const [user, domain] = raw.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return raw.length <= 2 ? `${raw[0] ?? '?'}*` : `${raw.slice(0, 2)}***`;
}

/** Find a Figma token: shell env first, then the figmingo entry of any client config. */
export function findConfiguredToken(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): { token?: string; source: string } {
  const fromEnv = env.FIGMA_API_KEY || env.FIGMA_TOKEN;
  if (fromEnv) return { token: fromEnv, source: 'env' };
  for (const target of clientConfigTargets(homeDir, platform)) {
    try {
      const content = fs.readFileSync(target.path, 'utf8');
      if (target.kind === 'json') {
        const cfg = JSON.parse(content) as { mcpServers?: { figmingo?: { env?: Record<string, string> } } };
        const t = cfg.mcpServers?.figmingo?.env?.FIGMA_API_KEY;
        if (t) return { token: t, source: target.path };
      } else {
        const m = content.match(/^FIGMA_API_KEY = "([^"]+)"\s*$/m);
        if (m) return { token: m[1], source: target.path };
      }
    } catch {
      /* unreadable / missing config — keep looking */
    }
  }
  return { source: 'none' };
}

export async function checkToken(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  homeDir?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck> {
  const { token, source } = findConfiguredToken(env, homeDir ?? os.homedir(), platform);
  if (!token) {
    return {
      id: 'token',
      label: 'Figma token configured',
      ok: false,
      detail: 'no FIGMA_API_KEY in env or any client config',
      fix: 'Get a PAT (Figma → Settings → Security → Personal access tokens) and re-run install.sh --token <pat>.',
    };
  }
  const via = source === 'env' ? 'env' : `config: ${source}`;
  try {
    const res = await fetchImpl('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': token } });
    if (!res.ok) {
      return {
        id: 'token',
        label: 'Figma token valid (/v1/me)',
        ok: false,
        detail: `HTTP ${res.status} (token from ${via})`,
        fix: 'Token rejected by Figma — generate a fresh PAT and update your client configs.',
      };
    }
    const me = (await res.json()) as { handle?: string; email?: string };
    const who = me.handle || me.email || 'unknown';
    return { id: 'token', label: 'Figma token valid (/v1/me)', ok: true, detail: `authenticated as ${maskHandle(who)} (${via})` };
  } catch (err) {
    return {
      id: 'token',
      label: 'Figma token valid (/v1/me)',
      ok: false,
      detail: (err as Error).message,
      fix: 'Could not reach api.figma.com — check the network/proxy and retry.',
    };
  }
}

const CHROMIUM_FIX = 'Chromium missing — run: npx playwright install chromium (or re-run install.sh).';

export async function defaultChromiumProbe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    if (fs.existsSync(exe)) return { ok: true, detail: exe };
  } catch {
    /* playwright package not resolvable */
  }
  // The renderer falls back to the system Chrome channel at runtime.
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (fs.existsSync(candidate)) return { ok: true, detail: `system Chrome: ${candidate}` };
  }
  return { ok: false, detail: 'no bundled chromium, no system Chrome' };
}

export async function checkChromium(probe: () => Promise<{ ok: boolean; detail: string }>): Promise<DoctorCheck> {
  const { ok, detail } = await probe();
  return { id: 'chromium', label: 'Chromium (HTML render/extract)', ok, detail, fix: ok ? undefined : CHROMIUM_FIX };
}

function sha256File(p: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return undefined;
  }
}

export function bundledPluginDir(): string {
  // src/doctor.ts → <pkg>/plugin; bundled dist/index.js → <pkg>/plugin.
  return fileURLToPath(new URL('../plugin', import.meta.url));
}

export function checkPlugin(homeDir: string, pluginSrcDir: string): DoctorCheck[] {
  const dir = path.join(homeDir, '.figmingo', 'plugin');
  const required = ['manifest.json', 'code.js', 'ui.html'];
  const missing = required.filter((f) => !fs.existsSync(path.join(dir, f)));
  const filesCheck: DoctorCheck = {
    id: 'plugin-files',
    label: 'Plugin files (~/.figmingo/plugin)',
    ok: missing.length === 0,
    detail: missing.length === 0 ? dir : `missing: ${missing.join(', ')}`,
    fix: missing.length === 0 ? undefined : 'Re-run install.sh (it copies manifest.json / code.js / ui.html), then re-import the plugin in Figma desktop.',
  };
  const installed = path.join(dir, 'code.js');
  const bundled = path.join(pluginSrcDir, 'code.js');
  const installedHash = sha256File(installed);
  const bundledHash = sha256File(bundled);
  let driftCheck: DoctorCheck;
  if (!installedHash) {
    driftCheck = { id: 'plugin-drift', label: 'Plugin code.js up to date', ok: false, detail: 'not installed', fix: filesCheck.fix };
  } else if (!bundledHash) {
    driftCheck = { id: 'plugin-drift', label: 'Plugin code.js up to date', ok: true, detail: 'bundled reference not found; skipped' };
  } else {
    const ok = installedHash === bundledHash;
    driftCheck = {
      id: 'plugin-drift',
      label: 'Plugin code.js up to date',
      ok,
      detail: ok ? 'matches the installed package' : `drift: installed ${installedHash.slice(0, 8)}… ≠ bundled ${bundledHash.slice(0, 8)}…`,
      fix: ok ? undefined : 'Re-run install.sh to sync ~/.figmingo/plugin, then re-import the plugin in Figma desktop.',
    };
  }
  return [filesCheck, driftCheck];
}

export interface ClientConfigTarget {
  id: string;
  label: string;
  path: string;
  kind: 'json' | 'toml';
}

export function clientConfigTargets(homeDir: string, platform: NodeJS.Platform): ClientConfigTarget[] {
  const mac = platform === 'darwin';
  return [
    { id: 'cursor', label: 'Cursor', path: path.join(homeDir, '.cursor', 'mcp.json'), kind: 'json' },
    { id: 'claude-code', label: 'Claude Code', path: path.join(homeDir, '.claude.json'), kind: 'json' },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      path: mac
        ? path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json'),
      kind: 'json',
    },
    {
      id: 'vscode',
      label: 'VS Code',
      path: mac
        ? path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : path.join(homeDir, '.config', 'Code', 'User', 'mcp.json'),
      kind: 'json',
    },
    { id: 'kimi', label: 'Kimi CLI', path: path.join(homeDir, '.kimi', 'mcp.json'), kind: 'json' },
    { id: 'codex', label: 'Codex', path: path.join(homeDir, '.codex', 'config.toml'), kind: 'toml' },
  ];
}

export function checkClientEntry(target: ClientConfigTarget): DoctorCheck {
  const label = `client config: ${target.label}`;
  let content: string;
  try {
    content = fs.readFileSync(target.path, 'utf8');
  } catch {
    return {
      id: `client-${target.id}`,
      label,
      ok: false,
      detail: `not found: ${target.path}`,
      fix: `Re-run install.sh --clients ${target.id} (or select all clients).`,
    };
  }
  let present = false;
  if (target.kind === 'json') {
    try {
      const cfg = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
      present = !!cfg.mcpServers?.figmingo;
    } catch {
      return { id: `client-${target.id}`, label, ok: false, detail: `invalid JSON: ${target.path}`, fix: 'Fix the JSON syntax or re-run install.sh.' };
    }
  } else {
    present = /^\[mcp_servers\.figmingo\]/m.test(content);
  }
  return {
    id: `client-${target.id}`,
    label,
    ok: present,
    detail: present ? target.path : `no figmingo entry in ${target.path}`,
    fix: present ? undefined : `Re-run install.sh --clients ${target.id}.`,
  };
}

export function defaultPortProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (listening: boolean) => {
      sock.destroy();
      resolve(listening);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

// --- runner + report ---------------------------------------------------------

export async function runDoctorChecks(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const chromiumProbe = deps.chromiumProbe ?? defaultChromiumProbe;
  const portProbe = deps.portProbe ?? defaultPortProbe;
  const bridgeHost = deps.bridgeHost ?? '127.0.0.1';
  const bridgePort = deps.bridgePort ?? 39220;

  const checks: DoctorCheck[] = [checkNode()];
  checks.push(await checkToken(env, fetchImpl, homeDir, deps.platform ?? process.platform));
  checks.push(await checkChromium(chromiumProbe));
  checks.push(...checkPlugin(homeDir, deps.pluginSrcDir ?? bundledPluginDir()));
  for (const target of clientConfigTargets(homeDir, deps.platform ?? process.platform)) {
    checks.push(checkClientEntry(target));
  }
  const listening = await portProbe(bridgeHost, bridgePort);
  checks.push({
    id: 'bridge-port',
    label: `bridge port ${bridgePort}`,
    ok: true,
    detail: listening
      ? 'a figmingo instance is already listening (expected while the MCP server runs)'
      : 'no listener right now (normal when no MCP client session is active)',
  });
  return checks;
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
  const icon = (ok: boolean) => (ok ? '✓' : '✗');
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = checks.map((c) => {
    const base = `${icon(c.ok)} ${c.label.padEnd(width)}  ${c.detail ?? ''}`.trimEnd();
    return c.ok || !c.fix ? base : `${base}\n    ↳ fix: ${c.fix}`;
  });
  const failed = checks.filter((c) => !c.ok).length;
  lines.push('');
  lines.push(failed === 0 ? 'all checks passed' : `${failed} check(s) need attention`);
  return lines.join('\n');
}

/** CLI entry: prints the report, returns the process exit code. */
export async function runDoctor(deps: DoctorDeps = {}): Promise<number> {
  const checks = await runDoctorChecks(deps);
  console.log(formatDoctorReport(checks));
  return checks.every((c) => c.ok) ? 0 : 1;
}
