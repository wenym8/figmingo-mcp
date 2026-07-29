/**
 * WebSocket server hosting the plugin bridge at ws://127.0.0.1:39220.
 * One companion plugin connection at a time; commands sent while
 * disconnected are queued (bounded) and flushed on reconnect.
 *
 * Timeout model (no fixed hard cap): each dispatched command gets
 *   - an IDLE timer (default 20s, configurable) that is reset by every
 *     `progress` heartbeat from the plugin — batches send one per executed
 *     command, so a healthy long-running batch never trips it;
 *   - a TOTAL cap (default 5 min, overridable per call via timeoutMs).
 * A timeout error always lists the command indexes confirmed completed via
 * progress heartbeats, so callers know exactly what the canvas contains.
 */

import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeHello,
  type BridgeCommand,
  type BridgeProgress,
  type PluginToServer,
} from './protocol';

export interface ProgressEntry {
  index?: number;
  total?: number;
  command?: string;
  ok?: boolean;
  at: number;
}

export interface PendingCommand {
  envelope: BridgeCommand;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  idleTimer?: NodeJS.Timeout;
  totalTimer?: NodeJS.Timeout;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  /** Progress heartbeats received so far (batch: one per executed command). */
  progress: ProgressEntry[];
}

/** Error thrown on idle/total timeout; carries confirmed progress. */
export class BridgeTimeoutError extends Error {
  readonly kind: 'idle' | 'total';
  readonly command: string;
  readonly progress: ProgressEntry[];
  constructor(kind: 'idle' | 'total', p: PendingCommand, waitedMs: number) {
    const completed = p.progress.map((e) => e.index).filter((i): i is number => typeof i === 'number');
    const lastTotal = [...p.progress].reverse().find((e) => typeof e.total === 'number')?.total;
    const completedNote = p.progress.length
      ? ` Confirmed completed command indexes: [${completed.sort((a, b) => a - b).join(', ')}]` +
        (lastTotal !== undefined ? ` (${completed.length}/${lastTotal}).` : '.')
      : ' No progress was ever received (nothing is confirmed applied).';
    const backgroundNote =
      ' The plugin may still be executing in the background — the canvas can contain partially-applied commands;' +
      ' inspect it (e.g. get_page_children) before retrying.';
    super(
      kind === 'idle'
        ? `plugin command ${p.envelope.command} timed out: no progress or result for ${waitedMs}ms (idle timeout).${completedNote}${backgroundNote}`
        : `plugin command ${p.envelope.command} timed out after ${waitedMs}ms (total cap).${completedNote}${backgroundNote}`,
    );
    this.name = 'BridgeTimeoutError';
    this.kind = kind;
    this.command = p.envelope.command;
    this.progress = p.progress;
  }
  get completedIndexes(): number[] {
    return this.progress.map((e) => e.index).filter((i): i is number => typeof i === 'number').sort((a, b) => a - b);
  }
}

/**
 * Adaptive total cap for batch commands: max(120s, commandCount × 300ms).
 * A 500-command import batch would otherwise trip a fixed cap while perfectly
 * healthy; the 20s idle heartbeat timeout stays the primary circuit breaker.
 */
export function adaptiveBatchTimeoutMs(commandCount: number): number {
  return Math.max(120_000, commandCount * 300);
}

export interface BridgeOptions {
  host?: string;
  port?: number;
  /**
   * Deprecated alias for maxWaitMs (kept for backward compatibility).
   * Previously a fixed 30s per-command hard timeout.
   */
  commandTimeoutMs?: number;
  /** Idle timeout: max silence between progress heartbeats/result (default 20s). */
  idleTimeoutMs?: number;
  /** Total cap per command once sent (default 5 min). */
  maxWaitMs?: number;
  /** Max queued commands while disconnected (default 100). */
  queueLimit?: number;
  serverVersion?: string;
}

export interface BridgeClientInfo {
  sessionId: string;
  pluginVersion?: string;
  fileName?: string;
  editorType?: string;
  connectedAt: string;
}

export class PluginBridge extends EventEmitter {
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private clientInfo?: BridgeClientInfo;
  private pending = new Map<string, PendingCommand>();
  private queue: PendingCommand[] = [];
  private seq = 0;
  private opts: {
    host: string;
    port: number;
    idleTimeoutMs: number;
    maxWaitMs: number;
    queueLimit: number;
    serverVersion: string;
  };
  private started = false;

  constructor(opts: BridgeOptions) {
    super();
    this.opts = {
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 39220,
      idleTimeoutMs: opts.idleTimeoutMs ?? 20_000,
      // commandTimeoutMs is a deprecated alias for the total cap.
      maxWaitMs: opts.maxWaitMs ?? opts.commandTimeoutMs ?? 300_000,
      queueLimit: opts.queueLimit ?? 100,
      serverVersion: opts.serverVersion ?? '0.1.0',
    };
  }

  get port(): number {
    const addr = this.wss?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.opts.port;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ host: this.opts.host, port: this.opts.port });
      this.wss.on('listening', () => resolve());
      this.wss.on('error', (err) => reject(err));
      this.wss.on('connection', (ws) => this.onConnection(ws));
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const [, p] of this.pending) this.fail(p, new Error('bridge stopped'));
    this.pending.clear();
    for (const p of this.queue) this.fail(p, new Error('bridge stopped'));
    this.queue = [];
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  private onConnection(ws: WebSocket) {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      // Single plugin: replace the old connection.
      try {
        this.client.close(4000, 'replaced by new plugin connection');
      } catch {
        /* ignore */
      }
    }
    this.client = ws;
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => {
      if (this.client === ws) {
        this.client = undefined;
        this.clientInfo = undefined;
        // Fail in-flight commands; queued ones wait for the next connection.
        for (const [id, p] of this.pending) {
          this.fail(p, new Error('plugin disconnected'));
          this.pending.delete(id);
        }
        this.emit('disconnect');
      }
    });
    ws.on('error', () => {
      /* close handler covers cleanup */
    });
  }

  private onMessage(ws: WebSocket, data: unknown) {
    let msg: PluginToServer;
    try {
      msg = JSON.parse(String(data)) as PluginToServer;
    } catch {
      this.send(ws, { type: 'error', message: 'invalid JSON' });
      return;
    }
    if (msg.type === 'hello') {
      const hello = msg as BridgeHello;
      if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
        this.send(ws, { type: 'error', message: `protocol mismatch: server=${BRIDGE_PROTOCOL_VERSION} plugin=${hello.protocol}` });
      }
      this.clientInfo = {
        sessionId: hello.sessionId,
        pluginVersion: hello.pluginVersion,
        fileName: hello.fileName,
        editorType: hello.editorType,
        connectedAt: new Date().toISOString(),
      };
      this.send(ws, { type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, serverVersion: this.opts.serverVersion });
      this.emit('connect', this.clientInfo);
      this.flushQueue();
      return;
    }
    if (msg.type === 'progress') {
      this.onProgress(msg as BridgeProgress);
      return;
    }
    if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.clearTimers(p);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || `plugin command ${p.envelope.command} failed`));
    }
  }

  private onProgress(msg: BridgeProgress) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    p.progress.push({ index: msg.index, total: msg.total, command: msg.command, ok: msg.ok, at: Date.now() });
    // Heartbeat: the plugin is alive and working — reset the idle timer.
    this.armIdleTimer(p);
  }

  private clearTimers(p: PendingCommand) {
    if (p.idleTimer) clearTimeout(p.idleTimer);
    if (p.totalTimer) clearTimeout(p.totalTimer);
    p.idleTimer = undefined;
    p.totalTimer = undefined;
  }

  private armIdleTimer(p: PendingCommand) {
    if (p.idleTimer) clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => {
      this.pending.delete(p.envelope.id);
      this.clearTimers(p);
      p.reject(new BridgeTimeoutError('idle', p, p.idleTimeoutMs));
    }, p.idleTimeoutMs);
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  private fail(p: PendingCommand, err: Error) {
    this.clearTimers(p);
    p.reject(err);
  }

  private flushQueue() {
    if (!this.isConnected()) return;
    const queued = this.queue.splice(0);
    for (const p of queued) this.dispatch(p);
  }

  private dispatch(p: PendingCommand) {
    const ws = this.client;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.enqueue(p);
      return;
    }
    p.totalTimer = setTimeout(() => {
      this.pending.delete(p.envelope.id);
      this.clearTimers(p);
      p.reject(new BridgeTimeoutError('total', p, p.totalTimeoutMs));
    }, p.totalTimeoutMs);
    this.armIdleTimer(p);
    this.pending.set(p.envelope.id, p);
    this.send(ws, p.envelope);
  }

  private enqueue(p: PendingCommand): boolean {
    if (this.queue.length >= this.opts.queueLimit) return false;
    this.queue.push(p);
    return true;
  }

  isConnected(): boolean {
    return !!this.client && this.client.readyState === WebSocket.OPEN && !!this.clientInfo;
  }

  isStarted(): boolean {
    return this.started;
  }

  status() {
    return {
      connected: this.isConnected(),
      client: this.clientInfo,
      queuedCommands: this.queue.length,
      inFlightCommands: this.pending.size,
      address: `ws://${this.opts.host}:${this.opts.port}`,
    };
  }

  /**
   * Send a command to the plugin. While disconnected the command is queued
   * (bounded) and sent on reconnect; the idle/total timers start when sent.
   * Set opts.failIfDisconnected to reject immediately instead.
   * opts.timeoutMs overrides the total cap; without it, batch commands get an
   * adaptive cap of max(120s, commandCount × 300ms) and other commands get the
   * server default (5 min); opts.idleTimeoutMs overrides the idle timeout
   * (default 20s, reset by progress heartbeats — the primary circuit breaker).
   */
  execute<T = unknown>(
    command: string,
    params?: unknown,
    opts: { timeoutMs?: number; idleTimeoutMs?: number; failIfDisconnected?: boolean } = {},
  ): Promise<T> {
    const id = `cmd-${Date.now()}-${++this.seq}`;
    const envelope: BridgeCommand = { type: 'command', id, command, params };
    const batchCount =
      command === 'batch' && Array.isArray((params as { commands?: unknown[] } | undefined)?.commands)
        ? ((params as { commands: unknown[] }).commands.length ?? 0)
        : undefined;
    return new Promise<T>((resolve, reject) => {
      const p: PendingCommand = {
        envelope,
        resolve: resolve as (r: unknown) => void,
        reject,
        idleTimeoutMs: opts.idleTimeoutMs ?? this.opts.idleTimeoutMs,
        totalTimeoutMs: opts.timeoutMs ?? (batchCount !== undefined ? adaptiveBatchTimeoutMs(batchCount) : this.opts.maxWaitMs),
        progress: [],
      };
      if (!this.started) {
        reject(new Error('plugin bridge is not running on this server (started with --no-bridge or the port was busy)'));
        return;
      }
      if (!this.isConnected()) {
        if (opts.failIfDisconnected) {
          reject(new Error('figmingo companion plugin is not connected. Open Figma desktop → Plugins → Development → figmingo.'));
        } else if (!this.enqueue(p)) {
          reject(new Error(`bridge queue is full (${this.opts.queueLimit}); plugin not connected`));
        }
        return;
      }
      this.dispatch(p);
    });
  }
}
