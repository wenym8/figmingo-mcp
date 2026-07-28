# figmingo-mcp Architecture (v1)

> Local-first, complete Figma MCP server. Works on **free** Figma plans — no seat
> quotas, no monthly caps. Feature-parity with the official Figma MCP on the read
> side, plus write-to-canvas via a companion plugin bridge, plus HTML 1:1 replica
> tooling with built-in acceptance gates.

## Goals

1. **Feature parity with official Figma MCP** (read side) using only the public
   REST API + Personal Access Token (PAT). No Dev seat required.
2. **Beyond Framelink**: screenshots, assets, variables/styles, search, metadata,
   caching — the gaps Framelink never filled.
3. **HTML 1:1 replica**: a replica-optimized spec tool + a three-gate parity
   verifier (content / structural / visual) ported from proven internal tooling.
4. **Write to canvas** (v1 included): companion Figma plugin bridged over local
   WebSocket. Works on free plans, no REST quota involved.
5. **One-command install** on macOS / Linux / Windows.

## Non-goals (v1)

- OAuth flow (PAT only; simpler, offline-friendly).
- Code Connect server-side mapping (official feature; we accept a local
  `figmingo.components.json` mapping file instead).
- Figma Make / Slides file support.

## Runtime & distribution

- **Language**: TypeScript on Node.js ≥ 18 (cross-platform: macOS, Windows, Linux).
- **MCP SDK**: `@modelcontextprotocol/sdk` (official TS SDK).
- **Transports**: stdio (default) and Streamable HTTP (`--http --port 3845`).
- **Install**:
  - `npx figmingo-mcp` zero-install run.
  - `install.sh` (curl | bash) and `install.ps1` (iwr | iex): check Node, install
    package, write MCP config into Cursor / Claude Code / Claude Desktop / VS Code,
    drop the companion plugin, print next steps.
- **License**: MIT.

## High-level diagram

```
AI client (Cursor / Claude Code / …)
        │  MCP (stdio or HTTP)
        ▼
┌───────────────────────────────────────────────┐
│ figmingo-mcp server                           │
│                                               │
│  tools/read/*   ──► FigmaRestClient ──► Figma │
│  (REST + PAT)        (rate-limit, retry,      │
│                       file cache)             │
│                                               │
│  tools/replica/* ─► Replica engine            │
│  (spec builder, three-gate verifier,          │
│   playwright + pixelmatch)                    │
│                                               │
│  tools/write/*  ──► PluginBridge (ws server)  │
└───────────────────────┬───────────────────────┘
                        │ ws://127.0.0.1:39220
                        ▼
              figmingo companion plugin
              (ui.html holds the ws + status panel;
               code.js sandbox executes Plugin API
               commands via postMessage)
```

## Tool list (v1 acceptance scope)

### Read tools (REST channel)

| Tool | Official equivalent | Notes |
|---|---|---|
| `get_design_context` | `get_design_context` | Simplified node tree: layout, styles, text, absolute bounds, auto-layout, fills, effects. Params: `fileKey?/url, nodeId?, depth?, format: json|compact`. |
| `get_metadata` | `get_metadata` | Lightweight tree (id, name, type, bounds) — XML or JSON, for orientation before deep fetch. |
| `get_screenshot` | `get_screenshot` | Node → PNG via `GET /v1/images/:fileKey`. Returns base64 inline or saves to disk. Params: `scale 0.01–4`, `format png|jpg|svg|pdf`. |
| `download_assets` | `download_assets` | Batch export up to N nodes + raw image fills (`GET /v1/files/:key/images` for fill URLs). Saves to a directory, returns manifest. |
| `get_variable_defs` | `get_variable_defs` | Try `GET /v1/files/:key/variables/local`; on 403 (non-Enterprise) fall back to `GET /v1/files/:key/styles` + tokens inferred from node styles. Mark `source:` in output. |
| `search_design_system` | `search_design_system` | Local index over the file's components/component_sets/styles; text query, type filter. |
| `get_code_connect_map` | `get_code_connect_map` | Reads `figmingo.components.json` (user-maintained component→code mapping); returns matches for a node subtree. |
| `whoami` | — | Token sanity check (`GET /v1/me`), rate-limit header report, cache status. |

### Replica tools (the differentiator)

| Tool | Purpose |
|---|---|
| `get_html_replica_spec` | Replica-optimized document: sections/elements with **absolute rects**, computed typography (family/style/size/letter-spacing/line-height/text-case), colors as hex+alpha, gradient data, asset manifest (icons→SVG nodes, image fills→download URLs, logo hints), text content. Ported design considerations from the internal `extract-layout.mjs` / `parity-lib.mjs`. |
| `render_html_screenshot` | Playwright (chromium) screenshot of a local/remote HTML page or element selector; waits for images, hides fixed elements on request. |
| `verify_html_parity` | The acceptance gate. Compares rendered HTML against the Figma spec + screenshots: **content gate** (copy, font, color), **structural gate** (position/size tolerance ±4 px), **visual gate** (pixelmatch diff ratio ≤ 1 %, 2 px crop tolerance). Emits a JSON report + diff images. |
| `compare_html_to_image` | One-shot visual diff against any reference image: renders the HTML with the same Playwright pipeline, then runs `comparePngBuffers` (pixelmatch, configurable threshold/`maxRatio` — `passed = diffRatio <= maxRatio`, default 1 %) with equal-height `bands: N` or custom `bandEdges: [y…]` strip localization (edges win), anti-alias accounting reported via `methodology` (AA pixels excluded from `diffPixels`/`diffRatio`), and `outDiffPath`/`outRenderPath` artifacts. |

### Write tools (plugin bridge channel)

| Tool | Purpose |
|---|---|
| `bridge_status` | Is the companion plugin connected? pending command queue size. |
| `execute_plugin_command` | Generic command envelope to the plugin: `create_frame`, `create_text`, `create_rectangle`, `set_fills`, `set_auto_layout`, `insert_image`, `move_node`, `resize_node`, `delete_node`, `get_selection`, `export_node`. Batched commands supported. |
| `import_html_replica` | High-level: take a replica spec (from `get_html_replica_spec`) and rebuild it as native Figma frames via the bridge. |

## Figma REST API facts that shape the design

- PAT header: `X-Figma-Token`. Free plan OK. Rate limits are per-minute only —
  no monthly quota (unlike official MCP's 6 calls/month on free).
- `GET /v1/files/:key` and `/v1/files/:key/nodes?ids=…` — document data.
- `GET /v1/images/:key?ids=…&format=png&scale=2` — render nodes → temp URLs.
- `GET /v1/files/:key/images` — image-fill hash → URL map.
- `GET /v1/files/:key/variables/local` — **Enterprise only**; expect 403 → fallback.
- `GET /v1/files/:key/styles`, `/v1/teams/:id/styles` — published styles.
- **No REST write to the canvas.** All writes go through the plugin bridge.
- Temp URLs from `/v1/images` expire (~30 days); download immediately and cache.

## Caching

- Cache root: `~/.figmingo/cache/<fileKey>/` (document JSON, rendered images,
  image fills). TTL configurable (`--cache-ttl`, default 15 min for documents,
  30 days for renders). `cache_clear` command in CLI.

## Plugin bridge

- MCP server hosts `ws://127.0.0.1:39220` (configurable). Companion plugin
  (`plugin/`) connects on open, registers with a session token, executes command
  envelopes, returns results/errors. 30 s per-command timeout, queue while
  disconnected.
- Plugin = `manifest.json` + `code.js` + `ui.html`. **The WebSocket lives in
  the UI iframe**: the `code.js` sandbox cannot open sockets (`new WebSocket()`
  fails silently), so `ui.html` owns the connection (backoff reconnect 1 s →
  15 s, hello handshake, status panel) and relays command envelopes to the
  sandbox via `postMessage` (`pluginMessage` / `figma.ui.onmessage`). Proven
  architecture (same as figwright).
- CSP: Figma rejects `ws://` URLs in `allowedDomains`, so the manifest uses
  `"networkAccess": {"allowedDomains": ["*"]}`; in practice the plugin only
  talks to the local server, and image bytes are pushed over the socket.

## Acceptance (验收) plan

Every tool must pass:

1. **Unit tests** (vitest) with recorded API fixtures (`test/fixtures/*.json`).
2. **Live acceptance** (`npm run accept`, requires `FIGMA_API_KEY` + a test file
   key): hits the real API for every read tool, renders a replica spec, verifies
   a known-good HTML fixture against it, and round-trips write commands through
   the plugin bridge (skipped with a warning if plugin not connected).
3. Acceptance report printed as a checklist; anything failing = release blocker.

## Repo layout

```
figmingo-mcp/
├── package.json  tsconfig.json  README.md  LICENSE  ARCHITECTURE.md
├── src/
│   ├── index.ts            # stdio entry (bin: figmingo-mcp)
│   ├── server.ts           # MCP server setup, tool registration
│   ├── config.ts           # env/CLI config, cache paths
│   ├── figma/
│   │   ├── client.ts       # REST client: auth, rate-limit, retry, cache
│   │   ├── simplify.ts     # raw node → simplified design context
│   │   └── urls.ts         # figma URL parsing (fileKey/nodeId)
│   ├── tools/
│   │   ├── read/*.ts       # 8 read tools
│   │   ├── replica/*.ts    # 3 replica tools
│   │   └── write/*.ts      # 3 bridge tools
│   ├── replica/
│   │   ├── spec.ts         # replica spec builder
│   │   ├── verify.ts       # three-gate verifier (ported tolerances)
│   │   └── render.ts       # playwright screenshots
│   └── bridge/
│       ├── server.ts       # ws server, session, command queue
│       └── protocol.ts     # command envelope types
├── plugin/
│   ├── manifest.json
│   ├── code.ts → code.js   # companion plugin (sandbox half: Plugin API handlers)
│   ├── ui.html             # UI iframe: owns the WebSocket + status panel (static)
│   └── README.md           # how to import into Figma desktop
├── scripts/
│   ├── install.sh
│   └── install.ps1
└── test/
    ├── fixtures/           # recorded API responses + HTML fixture
    ├── unit/
    └── acceptance/
```
