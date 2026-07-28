# figmingo companion plugin

This plugin runs inside **Figma desktop** and gives figmingo-mcp write access to
the canvas over a local WebSocket (`ws://127.0.0.1:39220`). It works on free
plans — no REST quota involved.

## Architecture (why there are two halves)

Figma's plugin sandbox (`code.js`) **cannot open WebSockets** — `new WebSocket()`
fails silently there. So the connection lives in the UI iframe:

```
figmingo-mcp server (ws server, 127.0.0.1:39220)
        ▲   ws (hello / command / result envelopes)
        │
   ui.html  ── the WebSocket + reconnect backoff + status panel
        │   parent.postMessage({ pluginMessage }) ⇄ figma.ui.onmessage
        ▼
   code.js  ── sandboxed Plugin API half: executes command envelopes
               (handlers: create_frame, create_text, …) and returns results
```

- **ui.html** — single static file (inline JS/CSS, no build). Owns the socket:
  exponential-backoff reconnect (1 s → 15 s), sends the `hello` handshake
  (protocol / sessionId / pluginVersion / fileName / editorType — the
  Figma-specific parts are supplied by code.js on `ui-ready`), forwards server
  command envelopes into the sandbox, relays results back over the socket, and
  renders a small **status panel** (280×120): ● connected / ○ connecting /
  ✕ failed + reason, server address, executed-command count — you can see at a
  glance that nothing is stuck.
- **code.ts → code.js** — `figma.showUI(__html__, …)`, then a pure message
  loop: `ui-ready` → init payload; `command` → dispatch to the Plugin API
  handlers → `command-result` back to the UI. No socket code at all.
- `batch` supports variable capture: a command with `"as": "main"` stores its
  `nodeId`; later commands may reference it as `"parentId": "$main"`.
- Network access is `allowedDomains: ["*"]` (Figma rejects `ws://` URLs in
  allowedDomains — a wildcard is required for the local relay). In practice the
  plugin only talks to the figmingo-mcp server on your own machine; image bytes
  are pushed from that local server as base64. Nothing leaves your machine.

## Import (one time)

1. In Figma desktop: **Plugins → Development → Import plugin from manifest…**
2. Select this folder's `manifest.json`.
3. Start the MCP server (`figmingo-mcp` via your AI client, or
   `npx figmingo-mcp` manually).
4. Run **Plugins → Development → figmingo** and keep it open while you use the
   write tools (`execute_plugin_command`, `import_html_replica`). The status
   panel shows ● connected within a second; if it shows ○ connecting, start
   the MCP server; if it shows ✕ failed, hover the error text.

## Rebuild

```bash
npm run build:plugin   # tsc -p plugin/tsconfig.json → plugin/code.js (ui.html is static)
```
