# figmingo-mcp

[![npm version](https://img.shields.io/npm/v/figmingo-mcp.svg)](https://www.npmjs.com/package/figmingo-mcp)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20streamable%20http-purple.svg)](https://modelcontextprotocol.io)

**Local-first Figma MCP server.** Full read-side parity with the official Figma
MCP on **free** Figma plans (Personal Access Token + public REST API — no seat
quotas, no monthly caps), HTML 1:1 replica tooling with built-in three-gate
acceptance, and write-to-canvas through a companion plugin bridge.

[中文快速上手 →](#中文快速上手)

## Why figmingo?

| Capability | Official Figma MCP | Framelink (figma-developer-mcp) | figmingo-mcp |
|---|---|---|---|
| Free-plan read quota | ~6 calls/month (Dev seat for more) | unlimited (REST + PAT) | **unlimited (REST + PAT)** |
| Simplified design context | ✅ | ✅ | ✅ (+ absolute bounds, auto-layout, effects) |
| Metadata tree (XML/JSON) | ✅ | partial | ✅ |
| Screenshots (node → png/jpg/svg/pdf) | ✅ | ❌ | ✅ |
| Asset download (nodes + raw image fills) | ✅ | partial | ✅ + manifest |
| Variables / design tokens | ✅ (Enterprise API) | ❌ | ✅ with free-plan fallback (styles + inferred, `source` marked) |
| Design-system search | ✅ | ❌ | ✅ local index |
| Code Connect map | ✅ (server-side) | ❌ | ✅ local `figmingo.components.json` |
| whoami / rate-limit / cache status | ❌ | ❌ | ✅ |
| HTML 1:1 replica spec | ❌ | ❌ | ✅ |
| Playwright HTML screenshots | ❌ | ❌ | ✅ |
| Three-gate parity verifier (content/structural/visual) | ❌ | ❌ | ✅ |
| Write to canvas | ❌ | ❌ | ✅ companion plugin bridge |
| Disk cache (TTL) | ❌ | ❌ | ✅ 15 min docs / 30 days renders |

## Install

One command (macOS / Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/figmingo-mcp/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/<owner>/figmingo-mcp/main/scripts/install.ps1 | iex
```

The installer checks Node ≥ 18, installs the package, writes MCP config into
**Cursor** (`~/.cursor/mcp.json`), **Claude Code** (`~/.claude.json`),
**Claude Desktop**, **VS Code**, **Kimi CLI** (`~/.kimi/mcp.json`), and
**Codex CLI** (`~/.codex/config.toml`, TOML — only the
`[mcp_servers.figmingo]` section is touched; the original is backed up to
`config.toml.figmingo-bak`), copies the companion plugin to
`~/.figmingo/plugin`, and prints next steps.

Manual setup (any client):

```json
{
  "mcpServers": {
    "figmingo": {
      "command": "npx",
      "args": ["-y", "figmingo-mcp"],
      "env": { "FIGMA_API_KEY": "figd_..." }
    }
  }
}
```

- **Kimi CLI** — same JSON shape in `~/.kimi/mcp.json` (merge into `mcpServers`).
- **Codex CLI** — TOML in `~/.codex/config.toml`:

  ```toml
  [mcp_servers.figmingo]
  command = "figmingo-mcp"
  args = []

  [mcp_servers.figmingo.env]
  FIGMA_API_KEY = "figd_..."
  ```

  (omit the `[mcp_servers.figmingo.env]` table if you configure the token
  another way; use `command = "npx"`, `args = ["-y", "figmingo-mcp"]` for a
  zero-install run)

Get a Personal Access Token: **Figma → Settings → Security → Personal access
tokens → Generate new token** (read scopes are enough for the read tools).

## Usage

```bash
figmingo-mcp                      # stdio transport (default, what AI clients use)
figmingo-mcp --http --port 3845   # Streamable HTTP at http://127.0.0.1:3845/mcp
figmingo-mcp cache-clear          # wipe ~/.figmingo/cache
figmingo-mcp --help
```

Flags: `--token <pat>` · `--http` · `--port <n>` · `--bridge-port <n>` ·
`--no-bridge` · `--cache-ttl <min>` · `--cache-root <path>` · `--no-cache`.

## Tools (15)

### Read tools (REST + PAT, free plan OK)

| Tool | What it does |
|---|---|
| `whoami` | Token sanity check (`GET /v1/me`) + rate-limit observations + cache status. |
| `get_design_context` | Simplified node tree: absolute bounds, auto-layout, fills/strokes/effects, text styles. Params: `fileKey`/`url`, `nodeId`, `depth`, `format: json\|compact`. |
| `get_metadata` | Lightweight tree (id/name/type/bounds) as XML (default) or JSON — orient before deep fetches. |
| `get_screenshot` | Node → image via `GET /v1/images/:fileKey`. `scale 0.01–4`, `format png\|jpg\|svg\|pdf`, inline base64 and/or `savePath`. |
| `download_assets` | Batch-export up to N nodes + raw image fills (`GET /v1/files/:key/images`) into a directory; returns a manifest. |
| `get_variable_defs` | Tries `GET /v1/files/:key/variables/local`; on 403 (non-Enterprise) falls back to `GET /v1/files/:key/styles` + tokens inferred from node styles. Output marks `source`. |
| `search_design_system` | Local index over the file's components / component sets / styles; text query + type filter. |
| `get_code_connect_map` | Reads `figmingo.components.json` (user-maintained component→code mapping) and matches a node subtree. |

Every read tool accepts either `fileKey` or a full `url` (the `node-id` query
param is honored).

### Replica tools (the differentiator)

| Tool | What it does |
|---|---|
| `get_html_replica_spec` | Replica-optimized document: sections/elements with **absolute rects**, computed typography (family/style/size/letter-spacing/line-height/text-case), hex+alpha colors, gradient data, and an asset manifest (icons→SVG, image fills→URLs, logo/icon hints via configurable patterns). Writes `<outPath>` and returns a summary. |
| `render_html_screenshot` | Playwright (chromium) screenshot of a URL / local HTML file / raw HTML string; waits for images, optional `hideFixed`, `selector` element captures, full-page default. |
| `verify_html_parity` | The acceptance gate. Renders the HTML, extracts its layout, then runs three gates against the Figma spec: **content** (copy/font/color), **structural** (±4 px position/size), **visual** (pixelmatch diff ratio ≤ 1 %, 2 px crop tolerance). Emits `report.json` + diff images. |
| `compare_html_to_image` | One-shot visual diff: renders the HTML (same Playwright options as `render_html_screenshot`) and pixel-diffs it against any reference image (e.g. a Figma export). Returns pass/fail, diff ratio, anti-alias accounting, and **per-band diff localization** (`bands: N` splits the image into N horizontal strips and reports where the mismatches live). Eliminates the render → hand-written diff script two-step. |

The output schema of `get_html_replica_spec` **is** the input schema of
`verify_html_parity` (`specPath` or inline `spec`) — the closed loop.

Tolerances (ported from production-proven internal tooling):

```
POS_TOL = 4        FONT_SIZE_TOL = 1      LS_TOL = 0.5
LH_TOL  = 2        COLOR_TOL     = 2/255  VISUAL_MAX_RATIO = 0.01 (crop ≤ 2px)
```

Everything brand-specific is parameterized via options:
`skipSections`, `sectionMap`, `expectedCounts` (`{logos, assets, minIcons}`),
`looseRectHints`, `logoPattern`/`iconPattern`, font aliases/overrides.

### Write tools (companion plugin bridge)

| Tool | What it does |
|---|---|
| `bridge_status` | Plugin connected? queue size, client info, supported commands. |
| `execute_plugin_command` | Generic envelope: `create_frame`, `create_text`, `create_rectangle`, `set_fills`, `set_auto_layout`, `insert_image`, `move_node`, `resize_node`, `delete_node`, `get_selection`, `export_node` — plus `commands: [...]` batches (sequential, `$var` node-id refs). Queued (bounded) while disconnected; 30 s timeout. |
| `import_html_replica` | High-level: rebuild a replica spec as native Figma frames — main frame → section frames → text/image/svg/background nodes. `dryRun` previews the command plan. |

The companion plugin (`plugin/`) connects to the MCP server at
`ws://127.0.0.1:39220`. Import once: **Figma desktop → Plugins → Development →
Import plugin from manifest…** → select `~/.figmingo/plugin/manifest.json`
(or `plugin/manifest.json` in this repo), then keep it running. Works on free
plans — writes never touch the REST quota.

Architecture note: Figma's plugin sandbox (`code.js`) cannot open WebSockets,
so the socket lives in the plugin's **UI iframe** (`ui.html`) and command
envelopes are relayed between the iframe and the sandbox via `postMessage`
(same architecture as proven local plugins like figwright). The UI shows a
small status panel (● connected / ○ connecting / ✕ failed + reason, server
address, executed-command count) so you can tell at a glance the bridge is
alive. In practice the plugin only talks to your local server; image bytes are
pushed over the socket as base64.

## Free-plan availability

| Surface | Free plan |
|---|---|
| All read tools | ✅ PAT + public REST; per-minute rate limits only (auto-backoff on 429) |
| `get_variable_defs` | ✅ via fallback (`source: styles+inferred`); raw `variables/local` is Enterprise-only and returns 403 |
| Write tools | ✅ plugin API has no plan gating |
| MCP client support | ✅ any MCP-capable client (the official Figma desktop MCP is plan-gated; this server is not) |

## Acceptance (验收)

```bash
npm install
npm run build
npm test            # 90+ unit tests (vitest) with recorded fixtures

# live acceptance against the real API:
FIGMA_API_KEY=<pat> TEST_FILE_KEY=<file-key> [TEST_NODE_ID=1:2] npm run accept
```

`npm run accept` walks every tool and prints a ✅ / ⏭️ / ❌ checklist. It exits
gracefully with guidance when the token/file key is missing; write tools report
**SKIP** (not FAIL) when the companion plugin isn't connected.

## Development

```bash
npm run build         # tsup (dist/) + tsc (plugin/code.js)
npm run typecheck     # strict tsc --noEmit
npm test              # vitest
npm run accept        # live acceptance checklist
```

Repo layout: see [ARCHITECTURE.md](ARCHITECTURE.md) — it is the authoritative
spec for the tool list, REST facts, caching, bridge protocol, and the
acceptance plan.

## License

[MIT](LICENSE)

---

## 中文快速上手

1. **安装**（macOS / Linux）：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/<owner>/figmingo-mcp/main/scripts/install.sh | bash
   ```

   Windows 用 `scripts/install.ps1`。安装器会检测 Node ≥ 18、全局安装包、写入
   Cursor / Claude Code / Claude Desktop / VS Code / Kimi CLI（`~/.kimi/mcp.json`）/
   Codex CLI（`~/.codex/config.toml`，TOML，只改 `[mcp_servers.figmingo]` 段并自动备份）
   的 MCP 配置，并把伴侣插件复制到 `~/.figmingo/plugin`。

2. **获取 Figma PAT**：Figma → 设置 → 安全 → Personal access tokens → 生成新 token
   （读工具只需读权限）。写进 MCP 配置的 `env.FIGMA_API_KEY`，或导出环境变量。

3. **重启 AI 客户端**，让它调用 `whoami` 验证连通性。

4. **常用流程**：
   - 读设计：`get_design_context` / `get_metadata` / `get_screenshot`（传 `url` 即可，自动解析 `node-id`）。
   - HTML 1:1 复刻：`get_html_replica_spec` 生成 spec → 手写/生成 HTML →
     `verify_html_parity` 跑三关验收（文案/字体/颜色 ±容差、结构 ±4px、像素 diff ≤ 1%），
     产出 `report.json` 和 diff 图。
   - 写回画布：Figma 桌面端 **插件 → 开发 → 导入 plugin/manifest.json** 并保持运行
     （code.js 沙箱无法开 WebSocket，连接由插件 UI iframe 持有，面板会显示 ●已连接/○连接中/✕失败），
     然后 `import_html_replica`（先 `dryRun` 预览）或 `execute_plugin_command`。

5. **免费套餐**：全部读工具 + 写工具均可用；variables 接口是 Enterprise 限定，
   403 时自动降级为 styles + 推导 tokens（输出带 `source` 标记）。

6. **验收**：`npm test`（90+ 单测全绿）；真实 API 验收：
   `FIGMA_API_KEY=xxx TEST_FILE_KEY=xxx npm run accept`，逐项打勾/打叉/跳过。
