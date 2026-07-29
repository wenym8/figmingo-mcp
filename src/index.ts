import { loadConfig, parseArgv } from './config';
import { PluginBridge } from './bridge/server';
import { FigmaRestClient } from './figma/client';
import { createContext, startStdio, startHttp, SERVER_NAME, SERVER_VERSION } from './server';

const HELP = `${SERVER_NAME} ${SERVER_VERSION}
Local-first Figma MCP server (read parity + HTML 1:1 replica + plugin-bridge writes).

Usage:
  figmingo-mcp [options]            Start the MCP server (stdio by default)
  figmingo-mcp --http --port 3845   Start Streamable HTTP transport on 127.0.0.1
  figmingo-mcp doctor               Diagnose the local install (node, token, chromium, plugin, client configs)
  figmingo-mcp cache-clear          Remove the disk cache (~/.figmingo/cache)

Options:
  --token <pat>        Figma Personal Access Token (or FIGMA_API_KEY / FIGMA_TOKEN env)
  --http               Use Streamable HTTP transport instead of stdio
  --port <n>           HTTP port (default 3845)
  --bridge-port <n>    Plugin bridge port (default 39220)
  --no-bridge          Do not start the plugin bridge WebSocket server
  --cache-ttl <min>    Document cache TTL in minutes (default 15)
  --cache-root <path>  Cache root directory (default ~/.figmingo/cache)
  --no-cache           Disable the disk cache
  -h, --help           Show this help
  -v, --version        Show version
`;

async function main(): Promise<void> {
  const { args, flags } = parseArgv(process.argv.slice(2));
  if (flags.get('help') || flags.get('h')) {
    console.log(HELP);
    return;
  }
  if (flags.get('version') || flags.get('v')) {
    console.log(SERVER_VERSION);
    return;
  }

  const config = loadConfig(process.argv.slice(2));

  if (args[0] === 'doctor') {
    const { runDoctor } = await import('./doctor');
    process.exitCode = await runDoctor();
    return;
  }

  if (args[0] === 'cache-clear') {
    const client = new FigmaRestClient({
      token: config.token,
      cacheRoot: config.cacheRoot,
      docTtlMs: config.docCacheTtlMs,
      renderTtlMs: config.renderCacheTtlMs,
    });
    const { removed } = client.clearCache();
    console.log(`cleared ${removed} cache files from ${config.cacheRoot}`);
    return;
  }

  const bridge = new PluginBridge({ host: config.bridgeHost, port: config.bridgePort, serverVersion: SERVER_VERSION });
  if (config.bridgeEnabled) {
    try {
      await bridge.start();
      console.error(`plugin bridge listening on ws://${config.bridgeHost}:${config.bridgePort}`);
    } catch (err) {
      console.error(`warning: plugin bridge failed to start (${(err as Error).message}); write tools will report an error until the port is free`);
    }
  }

  const ctx = createContext(config, bridge);

  if (config.transport === 'http') {
    await startHttp(ctx, config.httpPort);
  } else {
    await startStdio(ctx);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
