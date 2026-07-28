import { describe, it, expect } from 'vitest';
import { parseArgv, loadConfig, DEFAULT_BRIDGE_PORT, DEFAULT_HTTP_PORT } from '../../src/config';

describe('config', () => {
  it('parseArgv splits flags and values', () => {
    const { args, flags } = parseArgv(['--http', '--port', '3845', '--token=abc', 'cache-clear']);
    expect(flags.get('http')).toBe(true);
    expect(flags.get('port')).toBe('3845');
    expect(flags.get('token')).toBe('abc');
    expect(args).toEqual(['cache-clear']);
  });

  it('loadConfig defaults to stdio + defaults', () => {
    const c = loadConfig([], {} as NodeJS.ProcessEnv);
    expect(c.transport).toBe('stdio');
    expect(c.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(c.bridgePort).toBe(DEFAULT_BRIDGE_PORT);
    expect(c.docCacheTtlMs).toBe(15 * 60 * 1000);
    expect(c.renderCacheTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(c.token).toBeUndefined();
  });

  it('token precedence: --token > FIGMA_API_KEY > FIGMA_TOKEN', () => {
    const env = { FIGMA_API_KEY: 'k1', FIGMA_TOKEN: 'k2' } as NodeJS.ProcessEnv;
    expect(loadConfig(['--token', 'cli'], env).token).toBe('cli');
    expect(loadConfig([], env).token).toBe('k1');
    expect(loadConfig([], { FIGMA_TOKEN: 'k2' } as NodeJS.ProcessEnv).token).toBe('k2');
  });

  it('flags: --http/--port/--no-bridge/--no-cache/--cache-ttl', () => {
    const c = loadConfig(['--http', '--port', '4000', '--no-bridge', '--no-cache', '--cache-ttl', '5'], {} as NodeJS.ProcessEnv);
    expect(c.transport).toBe('http');
    expect(c.httpPort).toBe(4000);
    expect(c.bridgeEnabled).toBe(false);
    expect(c.cacheEnabled).toBe(false);
    expect(c.docCacheTtlMs).toBe(5 * 60 * 1000);
  });
});
