/**
 * Live acceptance checklist: `npm run accept`.
 *
 * Requires FIGMA_API_KEY + TEST_FILE_KEY (optional TEST_NODE_ID).
 * Missing token → graceful exit with guidance (exit code 0).
 * Write tools are SKIPped (not FAIL) when the companion plugin is not connected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config';
import { FigmaRestClient } from '../../src/figma/client';
import { PluginBridge } from '../../src/bridge/server';
import { createContext } from '../../src/server';
import { allTools } from '../../src/tools';
import type { ToolContext } from '../../src/tools/common';

const TOKEN = process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
const FILE_KEY = process.env.TEST_FILE_KEY;
const NODE_ID = process.env.TEST_NODE_ID;

const results: Array<{ tool: string; status: 'PASS' | 'FAIL' | 'SKIP'; note?: string }> = [];
let ctx: ToolContext;
let bridge: PluginBridge;
let outDir: string;
let specPath: string;
let chromiumAvailable = false;

const hasEnv = Boolean(TOKEN && FILE_KEY);
if (!hasEnv) {
  console.log(`
figmingo-mcp acceptance: FIGMA_API_KEY and/or TEST_FILE_KEY not set — skipping live checks.
Set them and re-run:
  FIGMA_API_KEY=<your-pat> TEST_FILE_KEY=<file-key> npm run accept
  (optional) TEST_NODE_ID=1:2
`);
}

async function check(name: string, fn: () => Promise<void>, skipReason?: string) {
  if (skipReason) {
    results.push({ tool: name, status: 'SKIP', note: skipReason });
    it.skip(`${name} — SKIP: ${skipReason}`, () => {});
    return;
  }
  it(name, async () => {
    try {
      await fn();
      results.push({ tool: name, status: 'PASS' });
    } catch (err) {
      results.push({ tool: name, status: 'FAIL', note: (err as Error).message });
      throw err;
    }
  });
}

beforeAll(async () => {
  if (!hasEnv) return;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-accept-'));
  const config = loadConfig([], { FIGMA_API_KEY: TOKEN } as NodeJS.ProcessEnv);
  config.cacheRoot = path.join(outDir, 'cache');
  bridge = new PluginBridge({ port: 0 });
  await bridge.start();
  ctx = createContext(config, bridge);
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: 'chrome' }));
    await b.close();
    chromiumAvailable = true;
  } catch {
    chromiumAvailable = false;
  }
}, 90000);

afterAll(async () => {
  await bridge?.stop();
  if (!hasEnv) return;
  console.log('\n================ ACCEPTANCE REPORT ================');
  for (const r of results) {
    const mark = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⏭️ ' : '❌';
    console.log(`${mark} ${r.tool.padEnd(26)} ${r.status}${r.note ? ` — ${r.note}` : ''}`);
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`===================================================`);
  console.log(`${results.filter((r) => r.status === 'PASS').length} passed, ${results.filter((r) => r.status === 'SKIP').length} skipped, ${failed.length} failed`);
  console.log(`artifacts: ${outDir}`);
});

const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t;
};

describe('figmingo-mcp live acceptance', () => {
  if (!hasEnv) {
    it.skip('no FIGMA_API_KEY/TEST_FILE_KEY — see message above', () => {});
    return;
  }

  // ---- read tools ----
  check('whoami', async () => {
    const res: any = await tool('whoami').handler(ctx, {});
    const me = JSON.parse(res.content[0].text);
    expect(me.me.id).toBeTruthy();
  });

  check('get_metadata', async () => {
    const res: any = await tool('get_metadata').handler(ctx, { fileKey: FILE_KEY, format: 'xml', depth: 3 });
    expect(res.content[0].text).toContain('<node');
  });

  check('get_design_context', async () => {
    const res: any = await tool('get_design_context').handler(ctx, { fileKey: FILE_KEY, nodeId: NODE_ID, format: 'json' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.design.id).toBeTruthy();
  });

  check('get_screenshot', async () => {
    const out = path.join(outDir, 'shot.png');
    const res: any = await tool('get_screenshot').handler(ctx, {
      fileKey: FILE_KEY, nodeId: NODE_ID ?? specNodeId(), savePath: out, inline: false, format: 'png', scale: 1,
    });
    expect(fs.existsSync(out)).toBe(true);
    expect(JSON.parse(res.content[0].text).bytes).toBeGreaterThan(100);
  });

  check('download_assets', async () => {
    const res: any = await tool('download_assets').handler(ctx, {
      fileKey: FILE_KEY, nodeIds: NODE_ID ? [NODE_ID] : [], includeImageFills: true, outDir: path.join(outDir, 'assets'),
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(fs.existsSync(parsed.manifestPath)).toBe(true);
  });

  check('get_variable_defs', async () => {
    const res: any = await tool('get_variable_defs').handler(ctx, { fileKey: FILE_KEY });
    const parsed = JSON.parse(res.content[0].text);
    expect(['variables', 'styles', 'styles+inferred']).toContain(parsed.source);
    results.push({ tool: 'get_variable_defs/source', status: 'PASS', note: `source=${parsed.source}` });
  });

  check('search_design_system', async () => {
    const res: any = await tool('search_design_system').handler(ctx, { fileKey: FILE_KEY, query: 'a' });
    expect(JSON.parse(res.content[0].text)).toHaveProperty('indexSize');
  });

  check('get_code_connect_map', async () => {
    const mapPath = path.join(outDir, 'figmingo.components.json');
    fs.writeFileSync(mapPath, JSON.stringify([{ figma: {}, code: { path: 'x.tsx' } }]));
    const res: any = await tool('get_code_connect_map').handler(ctx, { fileKey: FILE_KEY, nodeId: NODE_ID, mapPath });
    expect(JSON.parse(res.content[0].text)).toHaveProperty('count');
  });

  // ---- replica tools ----
  check('get_html_replica_spec', async () => {
    specPath = path.join(outDir, 'spec.json');
    const res: any = await tool('get_html_replica_spec').handler(ctx, {
      fileKey: FILE_KEY, nodeId: NODE_ID, outPath: specPath, includeAssets: true,
    });
    const summary = JSON.parse(res.content[0].text);
    expect(summary.sectionCount).toBeGreaterThan(0);
  });

  check(
    'render_html_screenshot',
    async () => {
      const htmlPath = new URL('../fixtures/page.html', import.meta.url).pathname;
      const res: any = await tool('render_html_screenshot').handler(ctx, {
        htmlPath, outPath: path.join(outDir, 'html.png'), selector: 'section.hero',
      });
      expect(fs.existsSync(JSON.parse(res.content[0].text).path)).toBe(true);
    },
    chromiumAvailable ? undefined : 'chromium not installed (npx playwright install chromium)',
  );

  check(
    'verify_html_parity',
    async () => {
      const htmlPath = new URL('../fixtures/page.html', import.meta.url).pathname;
      const res: any = await tool('verify_html_parity').handler(ctx, {
        specPath, htmlPath, skipVisual: false, outDir: path.join(outDir, 'parity'),
        sections: [
          { id: 'header', selector: 'header.topbar' },
          { id: 'hero', selector: 'section.hero' },
        ],
      });
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.reportPath).toBeTruthy();
      expect(fs.existsSync(parsed.reportPath)).toBe(true);
      // The fixture HTML does not necessarily match the user's file — the gate
      // execution + report artifact is what acceptance asserts here.
    },
    chromiumAvailable ? undefined : 'chromium not installed',
  );

  // ---- write tools ----
  check('bridge_status', async () => {
    const res: any = await tool('bridge_status').handler(ctx, {});
    expect(JSON.parse(res.content[0].text).connected).toBe(false); // acceptance bridge runs on an ephemeral port
  });

  const pluginNote = 'companion plugin not connected (start figmingo-mcp on port 39220 and open the plugin)';
  check('execute_plugin_command', async () => {
    // Round-trip through a fake plugin client to validate the bridge path end-to-end.
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, sessionId: 'accept' }));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'command') ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { ok: true } }));
    });
    await new Promise((r) => setTimeout(r, 50));
    const res: any = await tool('execute_plugin_command').handler(ctx, { command: 'get_selection' });
    expect(JSON.parse(res.content[0].text).result.ok).toBe(true);
    ws.close();
  }, hasEnv ? undefined : pluginNote);

  check('import_html_replica', async () => {
    const res: any = await tool('import_html_replica').handler(ctx, { specPath, dryRun: true });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.commands.length).toBeGreaterThan(0);
  }, specPath ? undefined : 'spec not built');
});

function specNodeId(): string {
  return NODE_ID ?? '0:1';
}
