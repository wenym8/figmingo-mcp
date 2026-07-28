/**
 * export_node outPath: server-side persistence of the plugin's base64 payload.
 * The bytes cross the bridge socket as base64 (unchanged default); when the
 * caller passes params.outPath the server writes them to disk and the tool
 * result carries { path, bytes } instead of the inline base64.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, jsonOf } from './helpers';
import { executePluginCommand, persistExportBase64, persistBatchExports } from '../../src/tools/write/executePluginCommand';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function tmpOut(name: string) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'figmingo-export-')), name);
}

describe('export_node outPath persistence', () => {
  it('persistExportBase64 writes bytes to disk and strips base64', () => {
    const outPath = tmpOut('node.png');
    const result = persistExportBase64({ nodeId: '1:2', format: 'PNG', base64: PNG_1PX.toString('base64') }, outPath);
    expect(result.path).toBe(outPath);
    expect(result.bytes).toBe(PNG_1PX.length);
    expect(result.base64).toBeUndefined();
    expect(fs.readFileSync(outPath)).toEqual(PNG_1PX);
  });

  it('persistExportBase64 is a no-op without base64', () => {
    const outPath = tmpOut('never.png');
    const result = persistExportBase64({ nodeId: '1:2' }, outPath);
    expect(result).toEqual({ nodeId: '1:2' });
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('persistBatchExports persists only entries whose command carried outPath', () => {
    const out1 = tmpOut('a.png');
    const batchResult: any = {
      executed: 2,
      results: [
        { index: 0, command: 'export_node', ok: true, result: { nodeId: '1:2', base64: PNG_1PX.toString('base64') } },
        { index: 1, command: 'export_node', ok: true, result: { nodeId: '1:3', base64: PNG_1PX.toString('base64') } },
      ],
    };
    persistBatchExports(batchResult, [
      { command: 'export_node', params: { nodeId: '1:2', outPath: out1 } },
      { command: 'export_node', params: { nodeId: '1:3' } }, // no outPath → base64 kept
    ]);
    expect(batchResult.results[0].result.path).toBe(out1);
    expect(batchResult.results[0].result.base64).toBeUndefined();
    expect(batchResult.results[1].result.base64).toBe(PNG_1PX.toString('base64'));
    expect(fs.readFileSync(out1)).toEqual(PNG_1PX);
  });

  it('execute_plugin_command export_node + params.outPath saves to disk via the tool', async () => {
    const outPath = tmpOut('via-tool.png');
    const fakeBridge = {
      execute: async (command: string) => {
        expect(command).toBe('export_node');
        return { nodeId: '1:2', format: 'PNG', base64: PNG_1PX.toString('base64') };
      },
    };
    const ctx = makeCtx({ bridge: fakeBridge as any });
    const res = await executePluginCommand.handler(ctx, {
      command: 'export_node',
      params: { nodeId: '1:2', format: 'PNG', outPath },
    });
    const parsed = jsonOf(res);
    expect(parsed.result.path).toBe(outPath);
    expect(parsed.result.bytes).toBe(PNG_1PX.length);
    expect(parsed.result.base64).toBeUndefined();
    expect(fs.readFileSync(outPath)).toEqual(PNG_1PX);
  });

  it('batch export_node entries with outPath are persisted end-to-end via the tool', async () => {
    const outPath = tmpOut('batch.png');
    const fakeBridge = {
      execute: async () => ({
        executed: 1,
        total: 1,
        aborted: false,
        results: [{ index: 0, command: 'export_node', ok: true, result: { nodeId: '1:2', base64: PNG_1PX.toString('base64') } }],
      }),
    };
    const ctx = makeCtx({ bridge: fakeBridge as any });
    const res = await executePluginCommand.handler(ctx, {
      commands: [{ command: 'export_node', params: { nodeId: '1:2', outPath } }],
    });
    const parsed = jsonOf(res);
    expect(parsed.result.results[0].result.path).toBe(outPath);
    expect(fs.readFileSync(outPath)).toEqual(PNG_1PX);
  });

  it('export_node without outPath keeps inline base64 (default compatible)', async () => {
    const fakeBridge = {
      execute: async () => ({ nodeId: '1:2', format: 'PNG', base64: PNG_1PX.toString('base64') }),
    };
    const ctx = makeCtx({ bridge: fakeBridge as any });
    const res = await executePluginCommand.handler(ctx, { command: 'export_node', params: { nodeId: '1:2' } });
    expect(jsonOf(res).result.base64).toBe(PNG_1PX.toString('base64'));
  });
});
