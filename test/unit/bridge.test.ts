import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { PluginBridge } from '../../src/bridge/server';
import { BRIDGE_PROTOCOL_VERSION } from '../../src/bridge/protocol';

function connectClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, sessionId: 's1', pluginVersion: '0.1.0', fileName: 'Test' }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

describe('PluginBridge', () => {
  let bridge: PluginBridge | undefined;
  let client: WebSocket | undefined;

  afterEach(async () => {
    try {
      client?.close();
    } catch { /* ignore */ }
    await bridge?.stop();
    bridge = undefined;
    client = undefined;
  });

  it('executes a command round-trip', async () => {
    bridge = new PluginBridge({ port: 0, commandTimeoutMs: 1000 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.isConnected()).toBe(true);

    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'command') {
        client!.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { nodeId: '1:99', echoed: msg.params } }));
      }
    });
    const result = await bridge.execute<{ nodeId: string; echoed: any }>('create_frame', { name: 'X', width: 10 });
    expect(result.nodeId).toBe('1:99');
    expect(result.echoed).toEqual({ name: 'X', width: 10 });
    expect(bridge.status().client?.fileName).toBe('Test');
  });

  it('surfaces plugin errors', async () => {
    bridge = new PluginBridge({ port: 0, commandTimeoutMs: 1000 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'command') {
        client!.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'node not found' }));
      }
    });
    await expect(bridge.execute('delete_node', { nodeId: 'nope' })).rejects.toThrow('node not found');
  });

  it('times out commands that never answer', async () => {
    bridge = new PluginBridge({ port: 0, commandTimeoutMs: 100 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    await expect(bridge.execute('get_selection')).rejects.toThrow(/timed out/);
  });

  it('queues while disconnected and flushes on connect', async () => {
    bridge = new PluginBridge({ port: 0, commandTimeoutMs: 2000 });
    await bridge.start();
    const pending = bridge.execute('create_text', { characters: 'hi' });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.status().queuedCommands).toBe(1);

    client = await connectClient(bridge.port);
    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'command') {
        client!.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { nodeId: '2:7' } }));
      }
    });
    await expect(pending).resolves.toEqual({ nodeId: '2:7' });
  });

  it('failIfDisconnected rejects immediately', async () => {
    bridge = new PluginBridge({ port: 0 });
    await bridge.start();
    await expect(bridge.execute('get_selection', {}, { failIfDisconnected: true })).rejects.toThrow(/not connected/);
  });

  it('status reports address and counts', async () => {
    bridge = new PluginBridge({ port: 0 });
    await bridge.start();
    const s = bridge.status();
    expect(s.connected).toBe(false);
    expect(s.address).toContain('ws://127.0.0.1:');
  });
});
