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

  it('progress heartbeats reset the idle timer (no fixed hard cap)', async () => {
    // Idle 200ms, total 5s: without heartbeat resets this would die at ~200ms.
    bridge = new PluginBridge({ port: 0, idleTimeoutMs: 200, maxWaitMs: 5000 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== 'command') return;
      // Simulate a batch: heartbeat at 150ms and 320ms, result at 480ms.
      setTimeout(() => client!.send(JSON.stringify({ type: 'progress', id: msg.id, index: 0, total: 3, command: 'create_frame', ok: true })), 150);
      setTimeout(() => client!.send(JSON.stringify({ type: 'progress', id: msg.id, index: 1, total: 3, command: 'create_text', ok: true })), 320);
      setTimeout(() => client!.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { executed: 3 } })), 480);
    });
    const result = await bridge.execute<{ executed: number }>('batch', { commands: [{}, {}, {}] });
    expect(result.executed).toBe(3);
  });

  it('idle timeout error lists confirmed completed command indexes', async () => {
    bridge = new PluginBridge({ port: 0, idleTimeoutMs: 150, maxWaitMs: 5000 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== 'command') return;
      // Two commands confirmed applied, then the plugin goes silent.
      setTimeout(() => client!.send(JSON.stringify({ type: 'progress', id: msg.id, index: 0, total: 19, command: 'create_frame', ok: true })), 20);
      setTimeout(() => client!.send(JSON.stringify({ type: 'progress', id: msg.id, index: 1, total: 19, command: 'create_rectangle', ok: true })), 60);
    });
    const err = await bridge.execute('batch', { commands: [] }).then(
      () => { throw new Error('should have timed out'); },
      (e) => e,
    );
    expect(err.name).toBe('BridgeTimeoutError');
    expect(err.kind).toBe('idle');
    expect(err.completedIndexes).toEqual([0, 1]);
    expect(err.message).toMatch(/idle timeout/);
    expect(err.message).toContain('[0, 1]');
    expect(err.message).toContain('(2/19)');
    expect(err.message).toMatch(/partially-applied/);
  });

  it('total cap still fires even while heartbeats arrive', async () => {
    bridge = new PluginBridge({ port: 0, idleTimeoutMs: 100, maxWaitMs: 5000 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== 'command') return;
      // Well-behaved heartbeats every 60ms — idle never trips, total cap must.
      let i = 0;
      const tick = setInterval(() => {
        if (!client || client.readyState !== WebSocket.OPEN || i > 20) return clearInterval(tick);
        client!.send(JSON.stringify({ type: 'progress', id: msg.id, index: i, total: 100, command: 'create_frame', ok: true }));
        i++;
      }, 60);
    });
    // timeoutMs (per-call) overrides the 5s total cap → ~250ms.
    const err = await bridge.execute('batch', { commands: [] }, { timeoutMs: 250 }).then(
      () => { throw new Error('should have timed out'); },
      (e) => e,
    );
    expect(err.name).toBe('BridgeTimeoutError');
    expect(err.kind).toBe('total');
    expect(err.message).toMatch(/total cap/);
    expect(err.completedIndexes.length).toBeGreaterThanOrEqual(1);
  });

  it('timeoutMs and idleTimeoutMs are per-call, not sticky across commands', async () => {
    bridge = new PluginBridge({ port: 0, idleTimeoutMs: 500, maxWaitMs: 2000 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'command' && msg.command === 'get_selection') {
        client!.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { selection: [] } }));
      }
      // 'create_frame' is never answered.
    });
    await expect(bridge.execute('create_frame', {}, { timeoutMs: 150 })).rejects.toThrow(/total cap/);
    // A following command still gets the default generous timeouts and succeeds.
    await expect(bridge.execute('get_selection')).resolves.toEqual({ selection: [] });
  });
});

describe('adaptive batch timeout', () => {
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

  it('adaptiveBatchTimeoutMs = max(120s, commandCount × 300ms)', async () => {
    const { adaptiveBatchTimeoutMs } = await import('../../src/bridge/server');
    expect(adaptiveBatchTimeoutMs(0)).toBe(120_000);
    expect(adaptiveBatchTimeoutMs(10)).toBe(120_000);
    expect(adaptiveBatchTimeoutMs(1000)).toBe(300_000);
    expect(adaptiveBatchTimeoutMs(2000)).toBe(600_000);
  });

  it('a batch without explicit timeoutMs gets the adaptive cap, not maxWaitMs', async () => {
    // maxWaitMs 100ms would kill this batch; the adaptive cap (≥120s) lets a
    // 300ms-late result through.
    bridge = new PluginBridge({ port: 0, idleTimeoutMs: 2000, maxWaitMs: 100 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    client.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== 'command') return;
      setTimeout(() => client!.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result: { executed: 3 } })), 300);
    });
    const result = await bridge.execute<{ executed: number }>('batch', { commands: [{}, {}, {}] });
    expect(result.executed).toBe(3);
  });

  it('an explicit timeoutMs still overrides the adaptive cap', async () => {
    bridge = new PluginBridge({ port: 0, idleTimeoutMs: 2000, maxWaitMs: 100 });
    await bridge.start();
    client = await connectClient(bridge.port);
    await new Promise((r) => setTimeout(r, 50));
    await expect(bridge.execute('batch', { commands: [{}, {}, {}] }, { timeoutMs: 120 })).rejects.toThrow(/total cap/);
  });
});
