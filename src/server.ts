import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppConfig } from './config';
import { FigmaRestClient } from './figma/client';
import { PluginBridge } from './bridge/server';
import { allTools } from './tools';
import type { ToolContext } from './tools/common';

export const SERVER_NAME = 'figmingo-mcp';
export const SERVER_VERSION = '0.1.0';

export function createContext(config: AppConfig, bridge: PluginBridge): ToolContext {
  let client: FigmaRestClient | undefined;
  return {
    config,
    bridge,
    getClient: () => {
      if (!client) {
        client = new FigmaRestClient({
          token: config.token,
          cacheRoot: config.cacheRoot,
          cacheEnabled: config.cacheEnabled,
          docTtlMs: config.docCacheTtlMs,
          renderTtlMs: config.renderCacheTtlMs,
        });
      }
      return client;
    },
  };
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: any) => {
        try {
          return (await tool.handler(ctx, args)) as any;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true } as any;
        }
      },
    );
  }
  return server;
}

export async function startStdio(ctx: ToolContext): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio (bridge ${ctx.bridge.status().address})`);
}

/** Stateless Streamable HTTP: one server+transport per POST. */
export async function startHttp(ctx: ToolContext, port: number): Promise<http.Server> {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found; use POST /mcp' }));
      return;
    }
    if (req.method !== 'POST') {
      // Stateless mode: no SSE streams / sessions.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'method not allowed in stateless mode; use POST' }));
      return;
    }
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
    try {
      const server = createMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body as any);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on http://127.0.0.1:${port}/mcp`);
  return httpServer;
}
