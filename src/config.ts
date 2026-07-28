import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  /** Figma Personal Access Token (FIGMA_API_KEY / FIGMA_TOKEN / --token). */
  token?: string;
  /** MCP transport. */
  transport: 'stdio' | 'http';
  /** HTTP port when transport === 'http'. */
  httpPort: number;
  /** Host/port of the local plugin bridge WebSocket server. */
  bridgeHost: string;
  bridgePort: number;
  bridgeEnabled: boolean;
  /** Disk cache root. */
  cacheRoot: string;
  cacheEnabled: boolean;
  /** TTL for document JSON (default 15 min). */
  docCacheTtlMs: number;
  /** TTL for rendered images (default 30 days). */
  renderCacheTtlMs: number;
}

export const DEFAULT_HTTP_PORT = 3845;
export const DEFAULT_BRIDGE_PORT = 39220;
export const DEFAULT_DOC_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_RENDER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function defaultCacheRoot(): string {
  return path.join(os.homedir(), '.figmingo', 'cache');
}

export function figmingoHome(): string {
  return path.join(os.homedir(), '.figmingo');
}

interface Argv {
  args: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgv(argv: string[]): Argv {
  const args: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--') && !['http', 'no-bridge', 'no-cache', 'help', 'version'].includes(a.slice(2))) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function num(v: string | boolean | undefined, dflt: number): number {
  if (typeof v !== 'string') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): AppConfig {
  const { flags } = parseArgv(argv);
  const token =
    (typeof flags.get('token') === 'string' ? (flags.get('token') as string) : undefined) ||
    env.FIGMA_API_KEY ||
    env.FIGMA_TOKEN ||
    undefined;
  const docTtlMin = num(flags.get('cache-ttl'), DEFAULT_DOC_TTL_MS / 60000);
  return {
    token,
    transport: flags.get('http') ? 'http' : 'stdio',
    httpPort: num(flags.get('port'), DEFAULT_HTTP_PORT),
    bridgeHost: '127.0.0.1',
    bridgePort: num(flags.get('bridge-port'), DEFAULT_BRIDGE_PORT),
    bridgeEnabled: flags.get('no-bridge') !== true,
    cacheRoot: typeof flags.get('cache-root') === 'string' ? (flags.get('cache-root') as string) : defaultCacheRoot(),
    cacheEnabled: flags.get('no-cache') !== true,
    docCacheTtlMs: docTtlMin * 60 * 1000,
    renderCacheTtlMs: DEFAULT_RENDER_TTL_MS,
  };
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith(`~${path.sep}`) || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
