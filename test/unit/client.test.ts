import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FigmaRestClient, FigmaApiError } from '../../src/figma/client';

function tmpCache(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-cache-'));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('FigmaRestClient', () => {
  let cacheRoot: string;
  beforeEach(() => {
    cacheRoot = tmpCache();
  });

  it('sends X-Figma-Token and caches GET responses', async () => {
    const calls: Array<{ url: string; headers: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init?.headers });
      return jsonResponse({ name: 'File' });
    }) as typeof fetch;

    const client = new FigmaRestClient({ token: 'tok123', cacheRoot, docTtlMs: 60_000, renderTtlMs: 60_000, fetchImpl });
    const a = await client.getFile('KEY');
    const b = await client.getFile('KEY');
    expect((a as any).name).toBe('File');
    expect((b as any).name).toBe('File');
    expect(calls).toHaveLength(1); // second call served from cache
    expect(calls[0].headers['X-Figma-Token']).toBe('tok123');
    expect(client.rateLimit.cacheHits).toBe(1);
  });

  it('retries on 429 honoring Retry-After', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return jsonResponse({}, 429, { 'retry-after': '0' });
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const client = new FigmaRestClient({ token: 't', cacheRoot, docTtlMs: 0, renderTtlMs: 0, fetchImpl, sleep: async () => {} });
    const res: any = await client.getMe();
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
    expect(client.rateLimit.total429).toBe(1);
  });

  it('throws FigmaApiError with status on 403 (variables/local fallback path)', async () => {
    const body = JSON.parse(fs.readFileSync(new URL('../fixtures/variables-403.json', import.meta.url), 'utf8'));
    const fetchImpl = (async () => jsonResponse(body, 403)) as typeof fetch;
    const client = new FigmaRestClient({ token: 't', cacheRoot, docTtlMs: 0, renderTtlMs: 0, fetchImpl, sleep: async () => {} });
    await expect(client.getLocalVariables('KEY')).rejects.toMatchObject({ status: 403 });
    await expect(client.getLocalVariables('KEY').catch((e) => e)).resolves.toBeInstanceOf(FigmaApiError);
  });

  it('exhausts retries and surfaces 429', async () => {
    const fetchImpl = (async () => jsonResponse({}, 429, { 'retry-after': '0' })) as typeof fetch;
    const client = new FigmaRestClient({ token: 't', cacheRoot, docTtlMs: 0, renderTtlMs: 0, fetchImpl, sleep: async () => {}, maxRetries: 2 });
    await expect(client.getFile('KEY')).rejects.toMatchObject({ status: 429 });
  });

  it('downloadBinary caches bytes and requires no token for temp URLs', async () => {
    const payload = Buffer.from('PNGDATA');
    const fetchImpl = (async () => new Response(payload)) as typeof fetch;
    const client = new FigmaRestClient({ token: undefined, cacheRoot, docTtlMs: 0, renderTtlMs: 60_000, fetchImpl });
    const buf1 = await client.downloadBinary('https://s3.example.com/x.png');
    const buf2 = await client.downloadBinary('https://s3.example.com/x.png');
    expect(buf1.toString()).toBe('PNGDATA');
    expect(buf2.toString()).toBe('PNGDATA');
  });

  it('requireToken produces a helpful error', () => {
    const client = new FigmaRestClient({ cacheRoot, docTtlMs: 0, renderTtlMs: 0 });
    expect(() => client.requireToken()).toThrow(/FIGMA_API_KEY/);
  });
});
