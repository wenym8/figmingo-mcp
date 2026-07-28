import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, jsonOf, textOf, FILE_KEY } from './helpers';
import { getDesignContext } from '../../src/tools/read/getDesignContext';
import { getMetadata } from '../../src/tools/read/getMetadata';
import { getScreenshot } from '../../src/tools/read/getScreenshot';
import { downloadAssets } from '../../src/tools/read/downloadAssets';
import { getVariableDefs } from '../../src/tools/read/getVariableDefs';
import { searchDesignSystem } from '../../src/tools/read/searchDesignSystem';
import { getCodeConnectMap } from '../../src/tools/read/getCodeConnectMap';
import { whoami } from '../../src/tools/read/whoami';

describe('read tools', () => {
  it('get_design_context returns simplified json and compact', async () => {
    const ctx = makeCtx();
    const json = await getDesignContext.handler(ctx, { fileKey: FILE_KEY, format: 'json' });
    const parsed = jsonOf(json);
    expect(parsed.file.key).toBe(FILE_KEY);
    expect(parsed.design.type).toBe('DOCUMENT');

    const compact = await getDesignContext.handler(ctx, { fileKey: FILE_KEY, nodeId: '1:10', format: 'compact' });
    expect(textOf(compact)).toContain('FRAME "Hero" #1:10');
    expect(textOf(compact)).toContain('Build faster with ACME');
  });

  it('get_design_context resolves figma urls', async () => {
    const ctx = makeCtx();
    const res = await getDesignContext.handler(ctx, {
      url: `https://www.figma.com/design/${FILE_KEY}/Landing?node-id=1-3`,
      format: 'json',
    });
    expect(jsonOf(res).design.name).toBe('Header');
  });

  it('get_metadata emits xml', async () => {
    const ctx = makeCtx();
    const res = await getMetadata.handler(ctx, { fileKey: FILE_KEY, format: 'xml' });
    expect(textOf(res)).toContain('<node id="0:0"');
    expect(textOf(res)).toContain('name="Landing Page"');
  });

  it('get_screenshot downloads and saves', async () => {
    const ctx = makeCtx();
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-shot-')), 'hero.png');
    const res: any = await getScreenshot.handler(ctx, { fileKey: FILE_KEY, nodeId: '1:11', savePath: out, inline: true, format: 'png', scale: 2 });
    expect(fs.existsSync(out)).toBe(true);
    expect(res.content.some((c: any) => c.type === 'image')).toBe(true);
  });

  it('download_assets writes files + manifest', async () => {
    const ctx = makeCtx();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-assets-'));
    const res = await downloadAssets.handler(ctx, { fileKey: FILE_KEY, nodeIds: ['1:2'], format: 'png', scale: 2, includeImageFills: true, outDir });
    const parsed = jsonOf(res);
    expect(parsed.saved.length).toBeGreaterThanOrEqual(2); // node render + image fill
    expect(fs.existsSync(parsed.manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(parsed.manifestPath, 'utf8'));
    expect(manifest.saved.map((s: any) => s.kind)).toContain('image-fill');
  });

  it('get_variable_defs falls back to styles+inferred on 403', async () => {
    const ctx = makeCtx();
    const res = await getVariableDefs.handler(ctx, { fileKey: FILE_KEY });
    const parsed = jsonOf(res);
    expect(parsed.source).toBe('styles+inferred');
    expect(parsed.note).toContain('403');
    expect(parsed.styles.map((s: any) => s.name)).toContain('Color/Brand Blue');
    expect(parsed.inferred.colors.length).toBeGreaterThan(0);
    expect(parsed.inferred.textStyles.length).toBeGreaterThan(0);
  });

  it('search_design_system finds components and styles', async () => {
    const ctx = makeCtx();
    const res = await searchDesignSystem.handler(ctx, { fileKey: FILE_KEY, query: 'button' });
    const parsed = jsonOf(res);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.results[0].name).toContain('Button');

    const styles = await searchDesignSystem.handler(ctx, { fileKey: FILE_KEY, query: 'brand', types: ['style'] });
    expect(jsonOf(styles).results.some((r: any) => r.kind === 'style')).toBe(true);
  });

  it('get_code_connect_map matches a subtree against figmingo.components.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-cc-'));
    const mapPath = path.join(dir, 'figmingo.components.json');
    fs.writeFileSync(
      mapPath,
      JSON.stringify([
        { figma: { componentName: 'Button/Primary' }, code: { path: 'src/Button.tsx', component: 'Button' } },
        { figma: { nodeId: '1:11' }, code: { path: 'src/Hero.tsx', component: 'Headline' } },
      ]),
    );
    const ctx = makeCtx();
    const res = await getCodeConnectMap.handler(ctx, { fileKey: FILE_KEY, nodeId: '1:10', mapPath });
    const parsed = jsonOf(res);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    expect(parsed.matches.some((m: any) => m.mapping.code.component === 'Button')).toBe(true);
  });

  it('whoami returns me + rate limit + cache + bridge status', async () => {
    const ctx = makeCtx();
    const parsed = jsonOf(await whoami.handler(ctx, {}));
    expect(parsed.me.handle).toBe('figmingo-tester');
    expect(parsed.cache.root).toBeDefined();
    expect(parsed.bridge.address).toContain('ws://');
  });
});
