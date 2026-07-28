import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FigmaRestClient } from '../../src/figma/client';
import { PluginBridge } from '../../src/bridge/server';
import { loadConfig } from '../../src/config';
import type { ToolContext } from '../../src/tools/common';

const FIX = (name: string) => JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

export const FILE_KEY = 'testFileKey123';

export function findNode(node: any, id: string): any {
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** A fetch stub routing the Figma REST surface to recorded fixtures. */
export function fixtureFetch(): typeof fetch {
  const file = FIX('file.json');
  const png1px = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  return (async (input: any) => {
    const url = String(input);
    const u = new URL(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (u.hostname !== 'api.figma.com') {
      return new Response(png1px); // temp render/fill URLs
    }
    const p = u.pathname;
    if (p === '/v1/me') return json(FIX('me.json'));
    if (p === `/v1/files/${FILE_KEY}`) return json(file);
    if (p === `/v1/files/${FILE_KEY}/nodes`) {
      const ids = (u.searchParams.get('ids') ?? '').split(',');
      const nodes: Record<string, unknown> = {};
      for (const id of ids) {
        const doc = findNode(file.document, id);
        if (doc) nodes[id] = { document: doc, components: {}, componentSets: {}, styles: {} };
        else nodes[id] = null;
      }
      return json({ nodes });
    }
    if (p === `/v1/images/${FILE_KEY}`) return json(FIX('images.json'));
    if (p === `/v1/files/${FILE_KEY}/images`) return json(FIX('image-fills.json'));
    if (p === `/v1/files/${FILE_KEY}/styles`) return json(FIX('styles.json'));
    if (p === `/v1/files/${FILE_KEY}/variables/local`) return json(FIX('variables-403.json'), 403);
    return json({ err: `unmocked ${p}` }, 404);
  }) as typeof fetch;
}

export function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-test-cache-'));
  const client = new FigmaRestClient({
    token: 'fixture-token',
    cacheRoot,
    cacheEnabled: false,
    docTtlMs: 0,
    renderTtlMs: 0,
    fetchImpl: fixtureFetch(),
  });
  const bridge = new PluginBridge({ port: 0 });
  const config = loadConfig([], { FIGMA_API_KEY: 'fixture-token' } as NodeJS.ProcessEnv);
  config.cacheRoot = cacheRoot;
  return {
    config,
    getClient: () => client,
    bridge,
    ...overrides,
  };
}

export function textOf(result: any): string {
  return result.content.find((c: any) => c.type === 'text')?.text ?? '';
}

export function jsonOf(result: any): any {
  return JSON.parse(textOf(result));
}
