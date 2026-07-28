import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, jsonOf, FILE_KEY } from './helpers';
import { getHtmlReplicaSpec } from '../../src/tools/replica/getHtmlReplicaSpec';
import { bridgeStatus } from '../../src/tools/write/bridgeStatus';
import { executePluginCommand } from '../../src/tools/write/executePluginCommand';
import { importHtmlReplica, buildImportCommands } from '../../src/tools/write/importHtmlReplica';
import { buildReplicaSpec } from '../../src/replica/spec';

describe('replica + write tools', () => {
  it('get_html_replica_spec writes a spec file and returns a summary', async () => {
    const ctx = makeCtx();
    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-spec-')), 'spec.json');
    const res = await getHtmlReplicaSpec.handler(ctx, { fileKey: FILE_KEY, nodeId: '1:2', outPath, includeAssets: true });
    const summary = jsonOf(res);
    expect(summary.specPath).toBe(outPath);
    expect(summary.sectionCount).toBe(5);
    expect(summary.assetCount).toBeGreaterThanOrEqual(2);
    const spec = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(spec.sections.map((s: any) => s.name)).toContain('Hero');
    // svg asset got a rendered url from /v1/images
    const svgAsset = spec.assets.find((a: any) => a.kind === 'svg');
    expect(svgAsset.url).toContain('.svg');
  });

  it('spec output schema matches verify input (closed loop)', async () => {
    const ctx = makeCtx();
    const res = await getHtmlReplicaSpec.handler(ctx, { fileKey: FILE_KEY, nodeId: '1:2', inline: true, includeAssets: true, outPath: path.join(os.tmpdir(), 'spec-loop.json') }) as { content: Array<{ type: string; text: string }> };
    const inlineSpec = JSON.parse(res.content[1].text);
    // The inline spec is directly consumable by verify_html_parity's `spec` param.
    expect(inlineSpec.version).toBe(1);
    expect(inlineSpec.sections[0]).toHaveProperty('rect');
    expect(inlineSpec.sections[0].elements[0]).toHaveProperty('style');
    expect(inlineSpec.sections[0].elements[0]).toHaveProperty('key');
  });

  it('bridge_status reports disconnected state with hint', async () => {
    const ctx = makeCtx();
    const parsed = jsonOf(await bridgeStatus.handler(ctx, {}));
    expect(parsed.connected).toBe(false);
    expect(parsed.hint).toContain('Import plugin');
    expect(parsed.supportedCommands).toContain('create_frame');
  });

  it('execute_plugin_command queues/fails cleanly without a plugin', async () => {
    const ctx = makeCtx();
    // bridge not started → clear error
    await expect(executePluginCommand.handler(ctx, { command: 'get_selection' })).rejects.toThrow(/not running|not connected/);
    await expect(executePluginCommand.handler(ctx, {})).rejects.toThrow(/required/);
  });

  it('buildImportCommands maps spec → bridge command plan', async () => {
    const file = JSON.parse(fs.readFileSync(new URL('../fixtures/file.json', import.meta.url), 'utf8'));
    const spec = buildReplicaSpec(file.document.children[0].children[0], {
      fileKey: FILE_KEY,
      imageFills: { abc123hash: 'https://figma-fills.example.com/abc/fill-product.png' },
    });
    const ctx = makeCtx();
    const plan = await buildImportCommands(ctx, spec, { includeImages: true });
    expect(plan.commands[0].command).toBe('create_frame');
    expect(plan.commands[0].as).toBe('main');
    const sectionFrames = plan.commands.filter((c) => c.command === 'create_frame' && c.as?.startsWith('sec'));
    // Header / Hero / Footer get section frames; loose image/svg children are placed directly into $main.
    expect(sectionFrames.length).toBe(3);
    const texts = plan.commands.filter((c) => c.command === 'create_text');
    expect(texts.length).toBeGreaterThanOrEqual(5);
    const headline = texts.find((c) => c.params?.characters === 'Build faster with ACME')!;
    expect(headline.params).toMatchObject({ fontSize: 56, x: 120, y: 144 - 64 });
    expect((headline.params as any).fontName).toEqual({ family: 'Inter', style: 'Bold' });
    const images = plan.commands.filter((c) => c.command === 'insert_image');
    expect(images.length).toBe(1); // product shot downloaded via fixture fetch
    expect(images[0].params?.bytesBase64).toBeTruthy();
    const rects = plan.commands.filter((c) => c.command === 'create_rectangle');
    expect(rects.some((c) => String(c.params?.name).startsWith('svg:'))).toBe(true); // vector w/o url → placeholder
  });

  it('import_html_replica dryRun returns the plan without a bridge', async () => {
    const file = JSON.parse(fs.readFileSync(new URL('../fixtures/file.json', import.meta.url), 'utf8'));
    const spec = buildReplicaSpec(file.document.children[0].children[0], { fileKey: FILE_KEY });
    const ctx = makeCtx();
    const res = await importHtmlReplica.handler(ctx, { spec, dryRun: true });
    const parsed = jsonOf(res);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.stats.texts).toBeGreaterThan(0);
    expect(parsed.commands.length).toBeGreaterThan(10);
  });
});
