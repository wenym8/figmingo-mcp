/**
 * WebSocket server hosting the plugin bridge at ws://127.0.0.1:39220.
 * One companion plugin connection at a time; commands sent while
 * disconnected are queued (bounded) and flushed on reconnect, each with its
 * own 30s timeout measured from the moment it is actually sent.
 */

import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeHello,
  type BridgeCommand,
  type PluginToServer,
} from './protocol';

export interface PendingCommand {
  envelope: BridgeCommand;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface BridgeOptions {
  host?: string;
  port?: number;
  /** Per-command timeout once sent (default 30s). */
  commandTimeoutMs?: number;
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
  private opts: Required<BridgeOptions>;
  private started = false;

  constructor(opts: BridgeOptions) {
    super();
    this.opts = {
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 39220,
      commandTimeoutMs: opts.commandTimeoutMs ?? 30_000,
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
    if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || `plugin command ${p.envelope.command} failed`));
    }
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  private fail(p: PendingCommand, err: Error) {
    if (p.timer) clearTimeout(p.timer);
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
    p.timer = setTimeout(() => {
      this.pending.delete(p.envelope.id);
      p.reject(new Error(`plugin command ${p.envelope.command} timed out after ${this.opts.commandTimeoutMs}ms`));
    }, this.opts.commandTimeoutMs);
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
   * (bounded) and sent on reconnect; the 30s timeout starts when sent.
   * Set opts.failIfDisconnected to reject immediately instead.
   */
  execute<T = unknown>(command: string, params?: unknown, opts: { timeoutMs?: number; failIfDisconnected?: boolean } = {}): Promise<T> {
    const id = `cmd-${Date.now()}-${++this.seq}`;
    const envelope: BridgeCommand = { type: 'command', id, command, params };
    return new Promise<T>((resolve, reject) => {
      const p: PendingCommand = {
        envelope,
        resolve: resolve as (r: unknown) => void,
        reject,
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
      const timeoutMs = opts.timeoutMs;
      if (timeoutMs && timeoutMs !== this.opts.commandTimeoutMs) {
        const prev = this.opts.commandTimeoutMs;
        this.opts.commandTimeoutMs = timeoutMs;
        this.dispatch(p);
        this.opts.commandTimeoutMs = prev;
      } else {
        this.dispatch(p);
      }
    });
  }
}
